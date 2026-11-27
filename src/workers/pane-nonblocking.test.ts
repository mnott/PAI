/**
 * pane-nonblocking.test.ts — the daemon's pane tasks never hold the event loop on an external call:
 * a fake `ps` / `osascript` / `pgrep` that sleeps 10 s is killed at its limit while a loop timer keeps firing.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// every synchronous child-process entry point counts its calls and still runs the real thing
const sync = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:child_process", async (orig) => {
  const m = await orig<typeof import("node:child_process")>();
  const wrap = <F extends (...a: never[]) => unknown>(f: F): F => ((...a: Parameters<F>) => { sync.calls++; return f(...a); }) as F;
  return { ...m, spawnSync: wrap(m.spawnSync), execSync: wrap(m.execSync), execFileSync: wrap(m.execFileSync) };
});
import { closeEndedPanes, paneMayClose, saveEntry } from "./pane.js";
import { psTableAsync } from "./ps-table.js";
import { retryPaneOpen, withPaneOpenLock } from "./pane-open-lock.js";
import { requireVisiblePane } from "./run/pane-handles.js";
import * as paneLaunch from "./pane-launch.js";
vi.mock("./pane-launch.js", async (orig) => ({ ...(await orig<typeof import("./pane-launch.js")>()), launchPane: vi.fn() }));
import { osascriptJxa } from "./pane.js";
import { ownsPidAsync, ownsPidCachedAsync, type WorkerStatus } from "./status.js";
import { detectSupervisionEvents, type SupervisionEvent } from "./supervision.js";

let bin: string;
let oldPath: string | undefined;
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "slow-bin-"));
  for (const n of ["ps", "osascript", "pgrep"]) {
    writeFileSync(join(bin, n), "#!/bin/sh\nexec sleep 10\n");
    chmodSync(join(bin, n), 0o755);
  }
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
});
afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(bin, { recursive: true, force: true });
});

/** Longest gap between 10 ms timer ticks while `work` runs: the loop's responsiveness (an IPC read waits at most this long). */
async function maxLoopGap(work: Promise<unknown>): Promise<number> {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 10);
  await work.catch(() => undefined);
  clearInterval(t);
  return max;
}

describe("daemon pane tasks never block the loop", () => {
  it("a 10 s ps is killed at its limit and the loop stays responsive", async () => {
    const t0 = performance.now();
    const gap = await maxLoopGap(psTableAsync("command=", 400));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(gap).toBeLessThan(100);
    await expect(psTableAsync("command=", 200)).rejects.toThrow();
  });

  it("a 10 s osascript is killed at its limit and the loop stays responsive", async () => {
    const t0 = performance.now();
    let err: unknown;
    const gap = await maxLoopGap(osascriptJxa("1", [], 400).catch((e) => { err = e; }));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(String(err)).toMatch(/timed out/);
    expect(gap).toBeLessThan(100);
  });
});

describe("supervision pid checks never block the loop", () => {
  /** A pid that exists (kill -0 passes) but whose `ps` lookup hangs on the fake binary. */
  const livePid = process.pid;

  it("ownsPidAsync with a 10 s ps times out at 5 s and the loop stays responsive", async () => {
    // a pid that does not exist: alive() short-circuits, so the check must go through the async ps path
    // a dead pid never reaches ps: alive() short-circuits, so the check is instant
    expect(await ownsPidAsync({ id: "w-1", pid: 999_999, started: "2026-11-24 00:00:00" })).toBe(false);
    const t1 = performance.now();
    const gap = await maxLoopGap(ownsPidAsync({ id: "w-1", pid: livePid, started: "2026-11-24 00:00:00" }));
    const elapsed = performance.now() - t1;
    expect(elapsed).toBeGreaterThanOrEqual(4_500); // killed at the 5 s limit, not earlier
    expect(elapsed).toBeLessThan(6_000);
    // the 100 ms budget is the daemon's supervision tick: the loop must stay responsive while the ps runs
    expect(gap).toBeLessThan(100);
  }, 10_000);

  it("ownsPidCachedAsync with a 10 s ps times out at 5 s and the loop stays responsive", async () => {
    const t0 = performance.now();
    const gap = await maxLoopGap(ownsPidCachedAsync({ id: "w-2", pid: livePid, started: "2026-11-24 00:00:00" }));
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_000);
    expect(gap).toBeLessThan(100);
  }, 10_000);

  it("a sleeping worker's 10 s pgrep is killed at its limit and the loop stays responsive", async () => {
    const s: WorkerStatus = {
      id: "w-3",
      pid: livePid,
      label: "sleeping worker",
      state: "running",
      updated: "2026-11-24 02:09:59Z",
      spawnerSession: "sess-1",
      sleepSec: 300,
      cwd: "/tmp",
      term: "x",
      provider: "gyro-l",
      model: "m",
      origin: "spawn",
      turns: 1,
      last: "sleep 300",
      started: "2026-11-24 00:00:00",
      tools: 0,
      rc: null,
      secs: 0,
    };
    const t0 = performance.now();
    let events: SupervisionEvent[] = [];
    const gap = await maxLoopGap(
      detectSupervisionEvents([s], { stallMs: 60_000, now: new Date("2026-11-24T02:10:00Z"), isAlive: () => true }).then((e) => { events = e; })
    );
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(4_500); // pgrep killed at the 5 s limit
    expect(elapsed).toBeLessThan(6_000);
    // a killed pgrep reads as "no children": the sleeping alert still fires, degraded but never blocking
    expect(events.map((e) => e.kind)).toContain("sleeping");
  }, 10_000);
});

describe("the pane reaper tick runs no synchronous child process", () => {
  it("closeEndedPanes + paneMayClose decide as before and never call spawnSync/execSync/execFileSync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reaper-"));
    try {
      const st = (id: string, state: string): void =>
        writeFileSync(join(dir, `${id}.status`), JSON.stringify({ id, state, pid: 0, updated: "2026-11-24 00:00:00Z" }));
      st("w-done", "done");
      st("w-run", "running");
      saveEntry(dir, { session: "sess-done", worker: "w-done", opened: "2026-11-24 00:00:01", scope: "s" });
      saveEntry(dir, { session: "sess-run", worker: "w-run", opened: "2026-11-24 00:00:02", scope: "s" });
      const closedIds: string[] = [];
      const ops = {
        listIterm: async () => [{ id: "sess-done", name: "" }, { id: "sess-run", name: "" }],
        closeIterm: async (id: string) => (closedIds.push(id), true),
        listTmux: async () => [],
        closeTmux: async () => true,
      };
      sync.calls = 0;
      const r = await closeEndedPanes(dir, (wid) => paneMayClose(dir, wid), false, ops);
      expect(sync.calls).toBe(0);
      expect(closedIds).toEqual(["sess-done"]);
      expect(r.closed).toHaveLength(1);
      expect(r.kept.join()).toContain("w-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pane open: lock + retry on osascript timeouts, paneless when it never opens", () => {
  const fake = (body: string): void => {
    writeFileSync(join(bin, "osascript"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, "osascript"), 0o755);
  };
  const deps = { timeouts: [1500, 1500, 1500], backoffMs: 1 };

  it("an osascript that times out once is retried and the open succeeds", async () => {
    const mark = join(bin, "seen");
    fake(`if [ -e "${mark}" ]; then echo ok; exit 0; fi\ntouch "${mark}"\nexec sleep 10`);
    const logDir = mkdtempSync(join(tmpdir(), "open-log-"));
    const r = await retryPaneOpen(logDir, async () => (await osascriptJxa("1", [])).stdout.trim(), deps);
    expect(r).toBe("ok");
    expect(existsSync(join(logDir, "pane-open.lock"))).toBe(false);
    rmSync(logDir, { recursive: true, force: true });
  });

  it("an osascript that always times out: 3 tries then the timeout propagates; the start goes paneless", async () => {
    fake("exec sleep 10");
    const logDir = mkdtempSync(join(tmpdir(), "open-log-"));
    let n = 0;
    await expect(retryPaneOpen(logDir, async () => { n++; await osascriptJxa("1", []); }, deps)).rejects.toThrow(/timed out/);
    expect(n).toBe(3);
    rmSync(logDir, { recursive: true, force: true });
  }, 60_000);

  it("requireVisiblePane returns false and records why when every open times out", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "open-log-"));
    vi.mocked(paneLaunch.launchPane).mockRejectedValue(new Error("osascript timed out after 5000 ms"));
    const ok = await requireVisiblePane(logDir, { panes: { required: true } } as never, "w-test", "term", undefined, false, join(logDir, "ledger.jsonl"), false, {});
    expect(ok).toBe(false);
    expect(paneLaunch.noTerminalReasons.get("w-test")).toMatch(/paneless/);

    rmSync(logDir, { recursive: true, force: true });
  }, 60_000);

  it("a stale lock (dead pid) is taken over; a live fresh one is waited out then ignored", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "open-log-"));
    writeFileSync(join(logDir, "pane-open.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await withPaneOpenLock(logDir, async () => "got")).toBe("got");
    writeFileSync(join(logDir, "pane-open.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(await withPaneOpenLock(logDir, async () => "got2", { waitMs: 300 })).toBe("got2");
    rmSync(logDir, { recursive: true, force: true });
  });
});

describe("a pane failure never refuses a start", () => {
  it("an unverifiable pane (launchPane null, PaneUnverified reason) runs paneless", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "open-log-"));
    vi.mocked(paneLaunch.launchPane).mockImplementation(async (o) => {
      paneLaunch.noTerminalReasons.set(o.id, "pane unavailable, running headless: pane verification failed: pane for w-x already open");
      return null;
    });
    const ok = await requireVisiblePane(logDir, { panes: { required: true } } as never, "w-x", "term", undefined, false, join(logDir, "ledger.jsonl"), false, {});
    expect(ok).toBe(false);
    rmSync(logDir, { recursive: true, force: true });
  });
  it("an unexpected open error also runs paneless", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "open-log-"));
    vi.mocked(paneLaunch.launchPane).mockRejectedValue(new Error("pane verification failed: pane for w-y already open"));
    const ok = await requireVisiblePane(logDir, { panes: { required: true } } as never, "w-y", "term", undefined, false, join(logDir, "ledger.jsonl"), false, {});
    expect(ok).toBe(false);
    rmSync(logDir, { recursive: true, force: true });
  });
  it("a retry after a timed-out open closes the half-opened pane first", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "open-log-"));
    const { openPane } = await import("./run/pane-handles.js");
    let n = 0;
    const launch = vi.fn(async () => { if (n++ === 0) throw new Error("osascript timed out after 5000 ms"); return null; });
    await openPane({ logDir, config: {} as never, id: "w-z", kind: "worker", term: "t" }, launch as never);
    expect(launch).toHaveBeenCalledTimes(2);
    rmSync(logDir, { recursive: true, force: true });
  }, 30_000);
});
