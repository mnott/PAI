import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The entry does its own stdin read and calls main() unconditionally at
// module scope — importing it in-process would run that read against the
// test runner's own stdin. Run it as a real subprocess with its own piped
// stdin, exactly like session-start/session-start-worker-guard.test.ts.
//
// Uses this checkout as the git work tree (it already has a .git dir), not a
// tmp-created one: a repo under os.tmpdir() would itself match the hook's
// /tmp exemption and mask the "inside a git work tree" case being tested.
describe("route-edits-to-worker", () => {
  const ENTRYPOINT = "src/hooks/ts/pre-tool-use/route-edits-to-worker.ts";
  const repo = process.cwd();

  function runHook(filePath: string, env: NodeJS.ProcessEnv = {}): string {
    // This test may itself run as a worker (PAI_WORKER=1 in its own env),
    // which must not leak into the child and mask the case under test.
    const { PAI_WORKER: _drop, ...baseEnv } = process.env;
    return execFileSync("bun", [ENTRYPOINT], {
      input: JSON.stringify({
        cwd: repo,
        tool_name: "Edit",
        tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
      }),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...baseEnv, ...env },
    });
  }

  it("allows a Notes/TODO.md edit (prints nothing)", () => {
    expect(runHook(join(repo, "Notes/TODO.md"))).toBe("");
  });

  it("blocks a source file edit with the standing message", () => {
    const out = runHook(join(repo, "src/workers/run.ts"));
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("main session does not edit code");
  });

  it("allows a source file edit when PAI_WORKER=1", () => {
    expect(runHook(join(repo, "src/workers/run.ts"), { PAI_WORKER: "1" })).toBe("");
  });
});
