import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// The entry does its own stdin read and calls main() unconditionally at
// module scope, and it must exercise the real exit-code/stderr contract —
// run it as a real subprocess, exactly like route-edits-to-worker.test.ts.
describe("security-validator", () => {
  const ENTRYPOINT = "src/hooks/ts/pre-tool-use/security-validator.ts";

  function runHook(
    command: string,
    env: NodeJS.ProcessEnv = {}
  ): { status: number | null; stdout: string; stderr: string } {
    const { PAI_WORKER: _drop, ...baseEnv } = process.env;
    try {
      const stdout = execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({
          session_id: "test",
          tool_name: "Bash",
          tool_input: { command },
          cwd: process.cwd(),
        }),
        encoding: "utf8",
        timeout: 15_000,
        env: { ...baseEnv, ...env },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("writes the deny reason to stderr with exit code 2", () => {
    const { status, stderr } = runHook("git stash", { PAI_WORKER: "1" });
    expect(status).toBe(2);
    expect(stderr).toContain("Blocked by PAI security validator:");
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("allows git stash list for an in-place worker", () => {
    const { status, stderr } = runHook("git stash list", { PAI_WORKER: "1" });
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("allows git stash show for an in-place worker", () => {
    const { status } = runHook("git stash show", { PAI_WORKER: "1" });
    expect(status).toBe(0);
  });

  it("denies git stash push for an in-place worker", () => {
    const { status, stderr } = runHook("git stash push -m wip", { PAI_WORKER: "1" });
    expect(status).toBe(2);
    expect(stderr).toContain("Blocked by PAI security validator:");
  });

  it("denies git stash pop for an in-place worker", () => {
    const { status } = runHook("git stash pop", { PAI_WORKER: "1" });
    expect(status).toBe(2);
  });

  it("allows an ordinary command", () => {
    const { status, stderr } = runHook("ls -la");
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });
});
