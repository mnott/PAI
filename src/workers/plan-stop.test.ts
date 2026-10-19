import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan } from "./plan.js";
import { planLockPath } from "./run-lock.js";
import { planStatus, planStopPath, requestPlanStop, runExitCode, runPlan, type RunLogEntry, type RunnerDeps } from "./plan-runner.js";

const plan = () =>
  parsePlan(`job: j\nrepo: /r\ngate: g\nprovider: local\nunits:\n  - id: u1\n    parts:\n      - {id: a, spec: A, files: [f1]}\n      - {id: b, spec: B, files: [f2], depends_on: [a]}\n`, "/x");

const tmp = () => mkdtempSync(join(tmpdir(), "plan-stop-"));

function deps(log: RunLogEntry[], over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => 0,
    log: (e) => log.push(e),
    startWorker: async (r) => ({ id: `w-${r.part.id}`, ok: true, tokens: 1 }),
    merge: async (id) => ({ ok: true, commit: `sha-${id}`, before: "base", output: "" }),
    unitCheck: async () => ({ ok: true, output: "" }),
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("plan stop marker", () => {
  it("ends with run-end stopped after the in-flight part, starting no new one", async () => {
    const dir = tmp();
    const planPath = join(dir, "plan.yaml");
    const log: RunLogEntry[] = [];
    const starts: string[] = [];
    const d = deps(log, {
      async startWorker(r) {
        starts.push(r.part.id);
        requestPlanStop(planPath); // stop requested while a is in flight
        return { id: `w-${r.part.id}`, ok: true };
      },
    });
    const s = await runPlan(plan(), { parallel: 2, stopPath: planStopPath(planPath) }, d);
    expect(starts).toEqual(["a"]);
    expect(s.merged).toEqual(["a"]);
    expect(s.stopped).toBe(true);
    expect(s.stuck).toBe(false);
    expect(runExitCode(s)).toBe(4);
    expect(log.at(-1)).toMatchObject({ event: "run-end", status: "stopped", ok: false });
    expect(existsSync(planStopPath(planPath))).toBe(false);
  });
  it("ignores a stale marker from before the run", async () => {
    const dir = tmp();
    const planPath = join(dir, "plan.yaml");
    requestPlanStop(planPath);
    const log: RunLogEntry[] = [];
    const s = await runPlan(plan(), { parallel: 1, stopPath: planStopPath(planPath) }, deps(log));
    expect(s.merged).toEqual(["a", "b"]);
    expect(s.stopped).toBeUndefined();
  });
});

describe("SIGTERM", () => {
  it("stops the active worker, writes run-end stopped naming the interrupted part, releases the lock, exits non-zero", async () => {
    const dir = tmp();
    const lockPath = planLockPath(join(dir, "plan.yaml"));
    const handlers: Array<(sig: NodeJS.Signals) => void> = [];
    const on = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation(((ev: string, fn: (sig: NodeJS.Signals) => void) => {
      if (ev === "SIGTERM") handlers.push(fn);
      return on(ev, fn);
    }) as typeof process.on);
    const log: RunLogEntry[] = [];
    const stopped: string[] = [];
    let exitCode: number | undefined;
    const exited = new Promise<void>((res) => {
      void runPlan(plan(), { parallel: 1, lockPath, lockDeps: { exit: (c) => { exitCode = c; res(); } } }, deps(log, {
        startWorker: () => new Promise(() => undefined), // a runs until killed
        stopActive: async () => void stopped.push("w-a"),
      }));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(lockPath)).toBe(true);
    handlers[0]("SIGTERM");
    await exited;
    for (const h of handlers) process.off("SIGTERM", h);
    process.off("SIGINT", handlers[0]);
    expect(stopped).toEqual(["w-a"]);
    expect(exitCode).toBe(143);
    expect(existsSync(lockPath)).toBe(false);
    expect(log.at(-1)).toMatchObject({ event: "run-end", status: "stopped", note: "interrupted=a" });
    // the next run restarts the part: it is not merged and the segment is closed
    expect(planStatus(plan(), log, 0).running).toEqual([]);
  });
});
