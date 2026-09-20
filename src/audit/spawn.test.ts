import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstUserPromptTokens, firstSessionId, findSessionTranscript } from "./spawn.js";
import { countTokens } from "./tokens.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-spawn-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeLog(dir: string, lines: unknown[]): string {
  const path = join(dir, "log.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return path;
}

describe("firstUserPromptTokens", () => {
  it("counts a string-content user message", () => {
    const path = writeLog(newDir(), [
      { type: "system" },
      { type: "user", message: { content: "hello there" } },
      { type: "assistant", message: { usage: {} } },
    ]);
    return firstUserPromptTokens(path).then((tokens) => {
      expect(tokens).toBe(countTokens("hello there"));
    });
  });

  it("concatenates text parts of an array-content user message", () => {
    const path = writeLog(newDir(), [
      { type: "user", message: { content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] } },
    ]);
    return firstUserPromptTokens(path).then((tokens) => {
      expect(tokens).toBe(countTokens("part one part two"));
    });
  });

  it("only reads the first user message, ignoring later ones", () => {
    const path = writeLog(newDir(), [
      { type: "user", message: { content: "first" } },
      { type: "user", message: { content: "second, much longer message" } },
    ]);
    return firstUserPromptTokens(path).then((tokens) => {
      expect(tokens).toBe(countTokens("first"));
    });
  });

  it("returns null when there is no user message", () => {
    const path = writeLog(newDir(), [{ type: "assistant", message: { usage: {} } }]);
    return firstUserPromptTokens(path).then((tokens) => {
      expect(tokens).toBeNull();
    });
  });
});

describe("firstSessionId", () => {
  it("returns the session_id off the first record that carries one", async () => {
    const path = writeLog(newDir(), [
      { type: "system", session_id: "abc-123" },
      { type: "assistant", message: { usage: {} } },
    ]);
    expect(await firstSessionId(path)).toBe("abc-123");
  });

  it("returns null when no record carries a session_id", async () => {
    const path = writeLog(newDir(), [{ type: "assistant", message: { usage: {} } }]);
    expect(await firstSessionId(path)).toBeNull();
  });
});

describe("worker-mirror-log prompt-token fallback", () => {
  it("locates the session transcript under a projects dir and reads its first user message", async () => {
    const mirrorDir = newDir();
    const mirrorPath = writeLog(mirrorDir, [
      { type: "system", session_id: "sess-1", hook_name: "SessionStart" },
      { type: "assistant", message: { usage: {} } },
    ]);

    const projectsDir = newDir();
    const projectDir = join(projectsDir, "-some-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-1.jsonl"),
      JSON.stringify({ type: "user", message: { content: "run the worker contract" } }) + "\n",
      "utf8"
    );

    const sessionId = await firstSessionId(mirrorPath);
    expect(sessionId).toBe("sess-1");

    const transcript = findSessionTranscript(sessionId!, projectsDir);
    expect(transcript).toBe(join(projectDir, "sess-1.jsonl"));

    const promptTokens = await firstUserPromptTokens(transcript!);
    expect(promptTokens).toBe(countTokens("run the worker contract"));
    expect(promptTokens).not.toBe(0);
  });

  it("returns null from findSessionTranscript when no transcript matches", () => {
    const projectsDir = newDir();
    expect(findSessionTranscript("missing-session", projectsDir)).toBeNull();
  });
});
