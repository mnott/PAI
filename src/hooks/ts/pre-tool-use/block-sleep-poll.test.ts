import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// The entry does its own stdin read and calls main() unconditionally at
// module scope — run it as a real subprocess with its own piped stdin,
// exactly like route-edits-to-worker.test.ts.
describe("block-sleep-poll", () => {
  const ENTRYPOINT = "src/hooks/ts/pre-tool-use/block-sleep-poll.ts";

  function runHook(command: string, extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}): string {
    // This test may itself run as a worker (PAI_WORKER=1 in its own env),
    // which must not leak into the child and mask the case under test.
    const { PAI_WORKER: _drop, ...baseEnv } = process.env;
    return execFileSync("bun", [ENTRYPOINT], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command, ...extra } }),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...baseEnv, ...env },
    });
  }

  it("denies a long sleep (interactive session)", () => {
    const out = runHook("sleep 590");
    const parsed = JSON.parse(out).hookSpecificOutput;
    expect(parsed.permissionDecision).toBe("deny");
    expect(parsed.permissionDecisionReason).toContain("sleep 590s blocked");
    expect(parsed.permissionDecisionReason).toContain("run_in_background: true");
  });

  it("denies a long sleep with the worker-specific reason when PAI_WORKER=1", () => {
    const out = runHook("sleep 590", {}, { PAI_WORKER: "1" });
    const parsed = JSON.parse(out).hookSpecificOutput;
    expect(parsed.permissionDecision).toBe("deny");
    expect(parsed.permissionDecisionReason).toContain("FOREGROUND with a Bash timeout up to 600000 ms");
  });

  it("allows a short sleep (prints nothing)", () => {
    expect(runHook("sleep 30")).toBe("");
  });

  it("allows a long sleep in the background (prints nothing)", () => {
    expect(runHook("sleep 590", { run_in_background: true })).toBe("");
  });
});
