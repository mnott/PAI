import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueue, removeTicket, tryStart } from "../builds/queue.js";
import { budgetCheck, type BudgetSnapshot } from "./time-budget.js";
import { createJobWatch, hasLiveChild, ownsLiveBuildJob } from "./job-watch.js";
import { saveStatus, type WorkerStatus } from "./status.js";

let dir: string;
let logDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobwatch-"));
  logDir = join(dir, "workers");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const snap = (jobActive: boolean): BudgetSnapshot => ({ progressAtMs: 0, testsPassed: 0, toolsOk: 0, commits: 0, jobActive });
const cfg = { enabled: true, factor: 2, cap: 120, minutes: 20 } as never;

// the ticket the real gate writes for `pai build run --full --key k -- ...` started in a worker's shell
const gateTicket = (worker: string) =>
  enqueue(dir, { pid: process.pid, label: "flutter build apk", session: `worker ${worker}`, worker, key: "pailot-android", cmd: "flutter build apk", mode: "full", kind: "build" });

describe("worker budget checkpoint sees its build job", () => {
  it("counts a real running ticket of the worker, not another worker's", async () => {
    const t = await gateTicket("w1");
    await tryStart(dir, t.id, 3);
    expect(ownsLiveBuildJob("w1", dir)).toBe(true);
    expect(ownsLiveBuildJob("w2", dir)).toBe(false);
  });

  it("a build that ended seconds before the checkpoint still counts for its window", async () => {
    const t = await gateTicket("w1");
    await tryStart(dir, t.id, 3);
    let now = 1_000_000;
    const watch = createJobWatch({ wid: "w1", logDir, dir, now: () => now });
    now += 15_000;
    expect(watch.sample()).toBe(true);
    await removeTicket(dir, t.id); // build failed at minute 3; checkpoint comes 30 s later
    now += 30_000;
    expect(ownsLiveBuildJob("w1", dir)).toBe(false);
    const jobActive = watch.activeSince(1_000_000);
    expect(jobActive).toBe(true);
    expect(budgetCheck(snap(false), snap(jobActive), { minutes: 20, cfg }).action).toBe("extend");
    // the next window (after the extend) with no job is idle again
    now += 60_000;
    expect(watch.activeSince(now - 1000)).toBe(false);
  });

  it("a log the worker waits on with `pai worker wait-on --log` counts while it grows", () => {
    const log = join(dir, "b.log");
    writeFileSync(log, "x");
    const st = { id: "w1", waitingOn: { pid: 1, cmd: "x", startedAt: null, log } } as unknown as WorkerStatus;
    saveStatus(logDir, st);
    let now = Date.now();
    const watch = createJobWatch({ wid: "w1", logDir, dir, now: () => now });
    now += 10_000;
    const fresh = new Date(now - 5_000);
    utimesSync(log, fresh, fresh);
    expect(watch.sample()).toBe(true); // written after the last look
    now += 10_000;
    const old = new Date(now - 60_000);
    utimesSync(log, old, old);
    expect(watch.sample()).toBe(false); // silent log, no job
  });
});

describe("an L1 with a live child is never idle", () => {
  const child = (o: Partial<WorkerStatus>) => ({ id: "c1", parent: "l1", state: "running", pid: process.pid, ...o }) as unknown as WorkerStatus;
  it("a running child of the worker keeps the checkpoint extending, never reviewing", () => {
    saveStatus(logDir, child({}));
    expect(hasLiveChild(logDir, "l1")).toBe(true);
    expect(hasLiveChild(logDir, "other")).toBe(false);
    const watch = createJobWatch({ wid: "l1", logDir, dir });
    const active = watch.activeSince(0);
    expect(active).toBe(true);
    expect(budgetCheck(snap(false), snap(active), { minutes: 20, cfg, maxMinutes: 20 }).action).toBe("extend");
  });
  it("a finished child does not count", () => {
    saveStatus(logDir, child({ state: "done" }));
    expect(hasLiveChild(logDir, "l1")).toBe(false);
  });
});
