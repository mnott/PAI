import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditHooks } from "./hooks.js";
import { countTokens } from "./tokens.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-hooks-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeSettings(cwd: string, hooks: unknown): void {
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks }), "utf8");
}

describe("auditHooks", () => {
  it("counts a SessionStart hook's stdout in the encoding's own tokens", () => {
    const cwd = newDir();
    const fixture = join(cwd, "fixture.txt");
    const fixtureText = "the quick brown fox jumps over the lazy dog\n".repeat(20);
    writeFileSync(fixture, fixtureText, "utf8");

    writeSettings(cwd, {
      SessionStart: [{ hooks: [{ type: "command", command: `cat ${fixture}` }] }],
    });

    const report = auditHooks(cwd);
    expect(report.readings).toHaveLength(1);
    expect(report.readings[0].event).toBe("SessionStart");
    expect(report.readings[0].tokens).toBe(countTokens(fixtureText));
    expect(report.totalsByEvent.SessionStart).toBe(countTokens(fixtureText));
  });

  it("sums multiple hooks on the same event", () => {
    const cwd = newDir();
    writeSettings(cwd, {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "printf hello" }] },
        { hooks: [{ type: "command", command: "printf world" }] },
      ],
    });

    const report = auditHooks(cwd);
    expect(report.totalsByEvent.UserPromptSubmit).toBe(countTokens("hello") + countTokens("world"));
  });

  it("records a hook's stderr/failure without throwing", () => {
    const cwd = newDir();
    writeSettings(cwd, {
      SessionStart: [{ hooks: [{ type: "command", command: "exit 1" }] }],
    });

    expect(() => auditHooks(cwd)).not.toThrow();
    const report = auditHooks(cwd);
    expect(report.readings).toHaveLength(1);
    expect(report.readings[0].tokens).toBe(0);
  });

  it("lists PreToolUse hooks and flags a Bash-matcher rewrite hook", () => {
    const cwd = newDir();
    writeSettings(cwd, {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "true" }] },
        { matcher: "Edit", hooks: [{ type: "command", command: "true" }] },
      ],
    });

    const report = auditHooks(cwd);
    expect(report.preToolUseHooks).toHaveLength(2);
    expect(report.preToolUseRewritesBash).toBe(true);
  });

  it("expands ${PAI_DIR} and $HOME in the command before running it", () => {
    const cwd = newDir();
    const scriptDir = join(cwd, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "hello.sh"), "#!/bin/sh\nprintf hi\n", { mode: 0o755 });

    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        env: { PAI_DIR: scriptDir },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sh ${PAI_DIR}/hello.sh" }] }] },
      }),
      "utf8"
    );

    const report = auditHooks(cwd);
    expect(report.readings[0].tokens).toBe(countTokens("hi"));
  });
});
