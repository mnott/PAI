import { describe, it, expect } from "vitest";
import { decideWorkerGuard, type WorkerGuardContext } from "./worker-guard.js";

const WT = "/work/wt/abc";
const ctx: WorkerGuardContext = {
  cwd: WT,
  home: "/home/u",
  worktreeRoot: WT,
  inWorktree: true,
  mainCheckout: "/work/main",
  testScript: () => "vitest",
};
const WORKER = { PAI_WORKER: "1" };
const run = (command: string, timeout?: number, env: Record<string, string> = WORKER) =>
  decideWorkerGuard({ tool_name: "Bash", tool_input: { command, timeout } }, env, () => ctx);

const RECIPE = "nohup sh -c 'timeout 590 make; sleep 300; echo $? > /tmp/job.rc' > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid";

describe("long foreground waits", () => {
  it.each([
    ["tool timeout 300000", "npm test", 300000],
    ["the real w37274 command", "timeout 590 zsh rounds.sh | tail -40", undefined],
    ["timeout with signal flag", "timeout -s KILL 590 make", undefined],
    ["sleep 300", "sleep 300", undefined],
    ["while + sleep 90", "while true; do sleep 90; done", undefined],
    ["gtimeout 10m", "gtimeout 10m make", undefined],
    ["inside bash -c", "bash -c 'sleep 300'", undefined],
  ])("denies: %s", (_n, cmd, to) => {
    const d = run(cmd, to);
    expect(d.decision).toBe("deny");
    const reason = (d as { reason: string }).reason;
    expect(reason).toContain("pai worker wait-on $(cat /tmp/job.pid) --log /tmp/job.log");
    expect(reason).toContain("block operator messages and supervision");
  });

  it.each([
    ["timeout 100", "timeout 100 npm test", 120000],
    ["wait-on", "pai worker wait-on 123 --log x", undefined],
    ["nohup recipe", RECIPE, undefined],
    ["sleep 30", "sleep 30", undefined],
  ])("allows: %s", (_n, cmd, to) => {
    expect(run(cmd, to).decision).toBe("allow");
  });

  it("allows long waits in an interactive session", () => {
    expect(run("timeout 590 make", 600000, {}).decision).toBe("allow");
  });
});
