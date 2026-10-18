import { describe, it, expect } from "vitest";
import { raiseWaitTimeout } from "./wait-timeout.js";
import { decideWorkerGuard, type WorkerGuardContext } from "./worker-guard.js";
import { waitOn } from "../../../workers/wait-on.js";
import { WAIT_MAX_CAP_SECS } from "../../../workers/wait.js";
import { PROBE_CAP_SECS } from "../../../workers/wait-probes.js";

const raise = (command: string, timeout?: number) => raiseWaitTimeout({ command, timeout })?.timeout;

describe("raiseWaitTimeout", () => {
  it("sets (N + 15) s, capped at 600 s", () => {
    expect(raise("pai worker wait-file /tmp/x.rc --max 590")).toBe(600000);
    expect(raise("pai worker wait w1 w2 --max 300")).toBe(315000);
    expect(raise("pai worker wait-on $(cat /tmp/j.pid) --log /tmp/j.log --max 200")).toBe(215000);
    expect(raise("pai worker wait-url http://127.0.0.1:1/ --max=400")).toBe(415000);
  });
  it("leaves short waits and other commands alone", () => {
    expect(raiseWaitTimeout({ command: "pai worker wait w1 --max 100" })).toBeNull();
    expect(raiseWaitTimeout({ command: "pai worker wait w1" })).toBeNull();
    expect(raiseWaitTimeout({ command: "sleep 300; echo --max 500" })).toBeNull();
  });
  it("keeps an existing larger timeout, raises a smaller one", () => {
    expect(raiseWaitTimeout({ command: "pai worker wait w1 --max 300", timeout: 600000 })).toBeNull();
    expect(raise("pai worker wait w1 --max 300", 120000)).toBe(315000);
  });
  it("ignores a wait command inside a heredoc body", () => {
    expect(raiseWaitTimeout({ command: "cat > /tmp/s.txt <<'EOF'\npai worker wait w1 --max 590\nEOF" })).toBeNull();
  });
  it("is applied by the worker guard, not clamped back to 120 s", () => {
    const ctx: WorkerGuardContext = { cwd: "/w", home: "/h", worktreeRoot: "/w", inWorktree: true, mainCheckout: "/m", testScript: () => "vitest" };
    const d = decideWorkerGuard({ tool_name: "Bash", tool_input: { command: "pai worker wait w1 --max 590" } }, { PAI_WORKER: "1" }, () => ctx);
    expect(d).toMatchObject({ decision: "allow", updatedInput: { timeout: 600000 } });
  });
});

describe("wait caps", () => {
  it("all wait verbs cap --max at 590", async () => {
    expect([WAIT_MAX_CAP_SECS, PROBE_CAP_SECS]).toEqual([590, 590]);
    expect(typeof waitOn).toBe("function");
  });
});
