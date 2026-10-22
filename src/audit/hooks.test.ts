import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { auditHooks, type HookRunner } from "./hooks.js";
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

/** Scripted runner: no real shell, so no wall-clock timeout can bite under load. */
function scripted(outputs: Record<string, { stdout: string; error?: string }>, seen: string[] = []): HookRunner {
  return (command) => {
    seen.push(command);
    return outputs[command] ?? { stdout: "" };
  };
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

    const report = auditHooks(cwd, scripted({ [`cat ${fixture}`]: { stdout: fixtureText } }));
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

    const report = auditHooks(cwd, scripted({ "printf hello": { stdout: "hello" }, "printf world": { stdout: "world" } }));
    expect(report.totalsByEvent.UserPromptSubmit).toBe(countTokens("hello") + countTokens("world"));
  });

  it("records a hook's stderr/failure without throwing", () => {
    const cwd = newDir();
    writeSettings(cwd, {
      SessionStart: [{ hooks: [{ type: "command", command: "exit 1" }] }],
    });

    const run = scripted({ "exit 1": { stdout: "", error: "exit 1" } });
    expect(() => auditHooks(cwd, run)).not.toThrow();
    const report = auditHooks(cwd, run);
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

    const report = auditHooks(cwd, scripted({}));
    expect(report.preToolUseHooks).toHaveLength(2);
    expect(report.preToolUseRewritesBash).toBe(true);
  });

  it("expands ${PAI_DIR} and $HOME in the command before running it", () => {
    const cwd = newDir();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        env: { PAI_DIR: "/pai-dir" },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sh ${PAI_DIR}/hello.sh $HOME/x" }] }] },
      }),
      "utf8"
    );

    const seen: string[] = [];
    const report = auditHooks(cwd, scripted({ [`sh /pai-dir/hello.sh ${homedir()}/x`]: { stdout: "hi" } }, seen));
    expect(seen).toEqual([`sh /pai-dir/hello.sh ${homedir()}/x`]);
    expect(report.readings[0].tokens).toBe(countTokens("hi"));
  });
});

describe("auditHooks without a runner", () => {
  it("lists hooks but executes nothing", () => {
    const cwd = newDir();
    const marker = join(cwd, "ran");
    writeSettings(cwd, {
      SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }],
    });
    const report = auditHooks(cwd);
    expect(report.readings).toHaveLength(1);
    expect(report.readings[0].tokens).toBe(0);
    expect(report.readings[0].error).toMatch(/not run/);
    expect(existsSync(marker)).toBe(false);
  });
});
