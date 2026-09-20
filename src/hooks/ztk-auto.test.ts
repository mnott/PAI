import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ztk-auto.sh reads the PreToolUse payload from stdin, decides whether the
// command should bypass ztk's (lossy, for short/structured output) rewrite
// step via ztk-passthrough.mjs, and otherwise shells out to the real `ztk`
// binary. A pass-through decision prints nothing and exits 0 — Claude Code
// treats a silent PreToolUse hook as "no opinion", i.e. the command runs
// untouched. A non-pass-through decision always produces JSON output.
describe("ztk-auto.sh", () => {
  const SCRIPT = "src/hooks/ztk-auto.sh";
  let fakeBinDir: string;

  // Stub `ztk` so the test doesn't depend on the real binary being installed
  // or on its exact output shape — only that ztk-auto.sh calls it and
  // forwards its (sed-patched) output for non-pass-through commands.
  beforeAll(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "ztk-auto-test-bin-"));
    const fakeZtk = join(fakeBinDir, "ztk");
    writeFileSync(
      fakeZtk,
      [
        "#!/bin/bash",
        "cat > /dev/null",
        'echo \'{"permissionDecision":"ask","hookSpecificOutput":{"updatedInput":{"command":"ztk run npm test"}}}\'',
      ].join("\n"),
    );
    chmodSync(fakeZtk, 0o755);
  });

  afterAll(() => {
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  function runHook(command: string): string {
    return execFileSync("bash", [SCRIPT], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
    });
  }

  it("passes through a plain ls (empty stdout, command runs untouched)", () => {
    expect(runHook("ls -la src")).toBe("");
  });

  it("sends an unrecognised command to ztk and rewrites it", () => {
    const stdout = runHook("npm test");
    expect(stdout).toContain("ztk run");
    expect(stdout).toContain('"permissionDecision":"allow"');
  });

  it("passes through a cd-prefixed wc command", () => {
    expect(runHook("cd /x && wc -l a")).toBe("");
  });

  it("passes through a pipeline whose last stage is tail", () => {
    expect(runHook("cargo build 2>&1 | tail -20")).toBe("");
  });

  it("passes through a command requesting --json output", () => {
    expect(runHook("pai worker ps --json")).toBe("");
  });
});
