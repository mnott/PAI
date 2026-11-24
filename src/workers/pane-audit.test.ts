import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLaunches, auditTick, isPaiContinuationStatus, type LaunchAuditDeps } from "./pane-audit.js";
import { loadStatusesCached, refreshCachedStatus, saveStatus } from "./status.js";

// The 2026-11-16 incident: the daemon's cached status view still held a worker's pre-pane first status
// (no pane field), while the bytes on disk said pane.exec true — and the audit stopped the worker as
// "running without having been started through the pane launcher". The audit judges the uncached status
// before stopping anyone: a worker whose status says its pane was opened, or whose pane record exists,
// is never stopped as unlaunched.

const T0 = Date.parse("2026-11-16T20:07:00");
const startedStamp = "2026-11-16 20:06:08"; // older than the start grace: the worker would be judged

const statusJson = (id: string, pid: number, pane?: { opened: boolean; exec?: boolean }): string =>
  JSON.stringify({ id, pid, runPid: pid, state: "running", started: startedStamp, updated: startedStamp, turns: 1, tools: 0, origin: "spawn", ...(pane ? { pane } : {}) });

function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), "pane-audit-test-"));
}

function auditWith(logDir: string, d: Partial<LaunchAuditDeps> = {}) {
  const full: LaunchAuditDeps = {
    records: () => [],
    alive: () => false,
    kill: () => undefined,
    closePane: async () => undefined,
    registered: () => false,
    stop: async () => undefined,
    ...d,
  };
  return auditLaunches(logDir, full, new Date(T0));
}

describe("auditLaunches never stops a worker launched in a pane", () => {
  it("status on disk says pane.exec true but the cached view lacks it: not stopped (the incident)", async () => {
    const logDir = makeLogDir();
    const id = "20261116-200608-91792";
    try {
      // the stale pre-pane status is what the cache sees first
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 91792));
      loadStatusesCached(logDir); // warm the cache with the pane-less copy
      // the runner records its pane; same size as before, so a stat-only reader keeps the stale copy
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 91792, { opened: true, exec: true }));
      const stopped: string[] = [];
      await auditWith(logDir, {
        workers: () => [{ id, startedMs: T0 - 60_000, exec: false, exempt: false }], // the stale cached entry
        stop: async (wid) => void stopped.push(wid),
      });
      expect(stopped).toEqual([]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("pane record exists in the registry but not in the cached view: not stopped", async () => {
    const logDir = makeLogDir();
    const id = "20261116-200821-31983";
    try {
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 31983));
      loadStatusesCached(logDir); // cached without a pane field
      const stopped: string[] = [];
      const out = await auditWith(logDir, {
        workers: () => [{ id, startedMs: T0 - 60_000, exec: false, exempt: false }],
        registered: (wid) => wid === id, // the pane registry has its entry
        stop: async (wid) => void stopped.push(wid),
      });
      expect(out).toEqual([]);
      expect(stopped).toEqual([]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("a genuinely unlaunched worker (no pane anywhere on disk) is still stopped", async () => {
    const logDir = makeLogDir();
    const id = "20261116-201326-46957";
    try {
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 46957));
      loadStatusesCached(logDir);
      const stopped: string[] = [];
      const out = await auditWith(logDir, {
        workers: () => [{ id, startedMs: T0 - 60_000, exec: false, exempt: false }],
        stop: async (wid) => void stopped.push(wid),
      });
      expect(stopped).toEqual([id]);
      expect(out.some((f) => f.kind === "unlaunched" && f.id === id)).toBe(true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // 2026-11-16, second incident: a reroute started by PAI itself (reroute.ts defaultSpawn) restarted the task
  // outside the pane launcher; the audit stopped it as "running without having been started through the pane
  // launcher". A PAI-started continuation is now launched through the launcher like any normal start; during
  // the start grace while its pane opens, the audit never stops it.
  const reroutedStatus = (id: string, pid: number): string =>
    JSON.stringify({ id, pid, runPid: pid, state: "running", started: startedStamp, updated: startedStamp, turns: 1, tools: 0, origin: "spawn", label: "the task (rerouted)", rerouted: "fakeB: stall", fallThroughOf: "20261116-195500-11111" });

  it("a reroute restart within the start grace (pane still opening) is not stopped as unlaunched", async () => {
    const logDir = makeLogDir();
    const id = "20261116-231501-57594";
    try {
      writeFileSync(join(logDir, `${id}.status`), reroutedStatus(id, 57594));
      loadStatusesCached(logDir);
      const stopped: string[] = [];
      const out = await auditWith(logDir, {
        // the cached view from before its pane landed; no registry entry yet — the launcher is mid-open
        workers: () => [{ id, startedMs: T0 - 10_000, exec: false, exempt: false }],
        records: () => [], // no launch record on disk: no launcher is opening anything
        launcherAlive: () => false, // and no wrapper or caller lives
        stop: async (wid) => void stopped.push(wid),
      });
      expect(stopped).toEqual([]);
      expect(out.some((f) => f.kind === "unlaunched" && f.id === id)).toBe(false);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("a continuation past the start grace with no pane anywhere is still stopped", async () => {
    const logDir = makeLogDir();
    const id = "20261116-231502-57595";
    try {
      writeFileSync(join(logDir, `${id}.status`), reroutedStatus(id, 57595));
      loadStatusesCached(logDir);
      const stopped: string[] = [];
      const out = await auditWith(logDir, {
        workers: () => [{ id, startedMs: T0 - 120_000, exec: false, exempt: false }], // past the start grace: its pane never came
        stop: async (wid) => void stopped.push(wid),
      });
      expect(stopped).toEqual([id]);
      expect(out.some((f) => f.kind === "unlaunched" && f.id === id)).toBe(true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("a reroute restart with its pane record is judged ok (the launcher opened it like a normal start)", async () => {
    const logDir = makeLogDir();
    const id = "20261116-231503-57596";
    try {
      writeFileSync(join(logDir, `${id}.status`), reroutedStatus(id, 57596));
      loadStatusesCached(logDir);
      const stopped: string[] = [];
      // two rounds past the start grace (the pending file makes the second one confirm)
      for (const now of [T0 + 120_000, T0 + 150_000]) {
        await auditTick(
          logDir,
          { toSession: async () => true, toPailot: async () => true },
          {
            tabs: async () => new Map([["HOST", "w1:t1"], ["PANE", "w1:t1"]]),
            procs: () => [{ id, kind: "worker", host: "HOST", startedMs: T0 - 60_000, live: true }],
            registry: () => [{ session: "PANE", worker: id, opened: "2026-11-16 20:07:00", host: "HOST" }],
            now: () => new Date(now),
            stop: async (wid) => void stopped.push(wid),
          }
        );
      }
      expect(stopped).toEqual([]);
      const { readAudit } = await import("./pane-audit.js");
      const v = readAudit(logDir).find((x) => x.id === id);
      expect(v?.mark).toBe("ok");
      expect(v?.session).toBe("PANE");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("isPaiContinuationStatus names the continuation kinds and nothing else", () => {
    expect(isPaiContinuationStatus({ label: "x (rerouted)" })).toBe(true);
    expect(isPaiContinuationStatus({ label: "x (fall-through)" })).toBe(true);
    expect(isPaiContinuationStatus({ label: "x (handed off)" })).toBe(true);
    expect(isPaiContinuationStatus({ rerouted: "cloud: queued 16m" })).toBe(true);
    expect(isPaiContinuationStatus({ handoffNote: "handed off to anthropic as w2 at 45 min" })).toBe(true);
    expect(isPaiContinuationStatus({ fallThroughOf: "w1" })).toBe(true);
    expect(isPaiContinuationStatus({ priorIds: ["w1"] } as never)).toBe(true);
    expect(isPaiContinuationStatus({ escalatedFrom: ["t2"] } as never)).toBe(true);
    // a normal start is not a continuation
    expect(isPaiContinuationStatus({ label: "fix the retry loop" })).toBe(false);
    expect(isPaiContinuationStatus({})).toBe(false);
  });

  it("auditTick stops nobody whose uncached status says the pane was opened (NO PANE path)", async () => {
    const logDir = makeLogDir();
    const id = "20261116-201036-77295";
    try {
      // no registry entry, no recorded session: the verdict is NO PANE, but the status proves the pane
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 77295, { opened: true, exec: true }));
      loadStatusesCached(logDir);
      const stopped: string[] = [];
      // two rounds past the start grace (the pending file makes the second one confirm)
      for (const now of [T0 + 120_000, T0 + 150_000]) {
        await auditTick(
          logDir,
          { toSession: async () => true, toPailot: async () => true },
          {
            tabs: async () => new Map([["HOST", "w1:t1"]]),
            procs: () => [{ id, kind: "worker", host: "HOST", startedMs: T0 - 60_000, live: true }],
            registry: () => [],
            now: () => new Date(now),
            stop: async (wid) => void stopped.push(wid),
          }
        );
      }
      expect(stopped).toEqual([]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("a rewrite stamped to the old whole-ms mtime (same size): the ns+ctime+ino key re-parses", () => {
    const logDir = makeLogDir();
    const id = "20261116-200608-91792";
    try {
      const withPane = statusJson(id, 91792, { opened: true, exec: true });
      // same size as the pane record's copy: an mtimeMs+size key cannot tell the two apart
      const paneless = `{"x":"${" ".repeat(withPane.length - '{"x":""}'.length)}"}`;
      expect(paneless.length).toBe(withPane.length);
      // what a coarse-granularity clock does to an atomic rewrite: both copies land in one whole-ms tick,
      // and the final mtime is stamped back to that tick. The ns mtime still differs (APFS stores ns) and
      // the rename bumps ctimeNs, so the fixed key re-parses where the old one kept the stale copy.
      const path = join(logDir, `${id}.status`);
      writeFileSync(path, withPane);
      utimesSync(path, new Date(1794855968000), new Date(1794855968000));
      loadStatusesCached(logDir); // warm: the cache holds the exec-true copy and its identity
      writeFileSync(path, paneless);
      utimesSync(path, new Date(1794855968000), new Date(1794855968000));
      expect(loadStatusesCached(logDir).find((s) => s.id === id)?.pane).toBeUndefined(); // the fresh bytes win
      expect(refreshCachedStatus(logDir, id)?.pane).toBeUndefined(); // and so does a direct re-read
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // The 2026-11-17 incident: an audit tick captured its `now` at 01:06:57, then ran ~90 s behind it (the
  // daemon was mid WORKER-GC), and with that stale clock stopped two fresh pane-launched runs — a young
  // check built on Math.abs(now - started) called a 2-second-old run "85 s past grace", and the pre-start
  // of the other took 47 s while its pane opened slowly. The audit now judges with a fresh clock (a start
  // AFTER the tick's clock means young, never abs-distance), counts the grace from the later of spawn and
  // pane-launch attempt, spares any run whose launcher is still opening its pane, and re-reads the status
  // and the registry uncached before every stop.

  const S0 = Date.parse("2026-11-17T01:08:22"); // when the real victim was spawned; its tick's clock was ~90 s older
  const tickClock = new Date(S0 - 90_000); // "01:06:57": the stale `now` of the incident's audit round

  it("(a) a tick clock captured 90 s before a run spawned does not stop it", async () => {
    const logDir = makeLogDir();
    const id = "20261117-010822-33427";
    try {
      // no pane field yet: the launcher is mid-open and the registry entry has not landed
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 33427));
      loadStatusesCached(logDir);
      const stopped: string[] = [];
      // two rounds past the pending-confirm gate; the tick's clock never moves from its stale capture
      for (let i = 0; i < 2; i++) {
        await auditTick(
          logDir,
          { toSession: async () => true, toPailot: async () => true },
          {
            tabs: async () => new Map([["HOST", "w1:t1"]]),
            procs: () => [{ id, kind: "worker", host: "HOST", startedMs: S0, live: true }], // spawned 90 s AFTER the clock
            registry: () => [],
            now: () => tickClock,
            launches: async () => undefined,
            stop: async (wid) => void stopped.push(wid),
          }
        );
      }
      expect(stopped).toEqual([]);
      const { readAudit } = await import("./pane-audit.js");
      const v = readAudit(logDir).find((x) => x.id === id);
      expect(v?.mark).toBe("ok"); // young, not ancient: the clock predates the run
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("(b) a run whose pre-start takes 45 s with its launcher alive is not stopped, and gets its pane", async () => {
    const logDir = makeLogDir();
    const id = "20261117-010619-59586";
    try {
      // spawned 01:06:19; the pane opens only at 01:07:04 (45 s of pre-start while WORKER-GC ran);
      // status has no pane field yet and the registry entry lands late — as in the incident
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 59586));
      loadStatusesCached(logDir);
      const openedMs = S0 + 45_000; // the launcher's pane-open moment on the fake clock
      let opened = false; // set once the run's own bytes prove its pane: only then may it be judged
      const stopped: string[] = [];
      for (const at of [S0 + 31_000, S0 + 46_000, S0 + 76_000]) {
        if (!opened && at >= openedMs) {
          opened = true;
          writeFileSync(join(logDir, `${id}.status`), statusJson(id, 59586, { opened: true, exec: true }));
        }
        await auditTick(
          logDir,
          { toSession: async () => true, toPailot: async () => true },
          {
            tabs: async () => new Map([["HOST", "w1:t1"], ["PANE", "w1:t1"]]),
            // the launcher's stamps count toward the grace: once its pane lands (S0+45 s) that stamp opens
            // the grace again, so at S0+76 s the run is only 31 s past its pane-launch attempt
            procs: () => [{ id, kind: "worker", host: "HOST", startedMs: S0, ...(opened ? { launchMs: openedMs } : {}), live: true }],
            registry: () => (opened ? [{ session: "PANE", worker: id, opened: new Date(openedMs).toISOString(), host: "HOST" }] : []),
            now: () => new Date(at), // a fresh clock each round: the verdict rests on real time
            launches: async () => undefined,
            // the pane launcher (wrapper + caller) stays alive until the pane opens
            launcherAlive: (pid) => !!pid && at < openedMs,
            stop: async (wid) => void stopped.push(wid),
          }
        );
      }
      expect(stopped).toEqual([]); // never stopped while its launcher was still opening the pane
      const { readAudit } = await import("./pane-audit.js");
      const v = readAudit(logDir).find((x) => x.id === id);
      expect(v?.mark).toBe("ok");
      expect(v?.session).toBe("PANE"); // and it ends up judged with its pane
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("(c) a genuinely unpaned running worker past grace with no launcher is still stopped", async () => {
    const logDir = makeLogDir();
    const id = "20261117-010900-11111";
    try {
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 11111));
      loadStatusesCached(logDir);
      const stopped: string[] = [];
      // two rounds past the pending-confirm gate; no registry entry, no launch record, nothing alive
      for (let i = 0; i < 2; i++) {
        await auditTick(
          logDir,
          { toSession: async () => true, toPailot: async () => true },
          {
            tabs: async () => new Map([["HOST", "w1:t1"]]),
            procs: () => [{ id, kind: "worker", host: "HOST", startedMs: S0 - 300_000, live: true }], // minutes past grace
            registry: () => [],
            now: () => new Date(), // a fresh clock: the verdict stands on real time
            launches: async () => undefined,
            launcherAlive: () => false, // no wrapper, no caller: nobody is opening its pane
            running: () => true, // the fake world's liveness: the test pids are not real processes
            stop: async (wid) => void stopped.push(wid),
          }
        );
      }
      expect(stopped).toEqual([id]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("the unlaunched path spares a run whose launcher is still alive, and notes the sparing once", async () => {
    // the launch record lives in $PAI_HOME/state/pane-exec and is read uncached (never through a seam):
    // run the round in a child process with PAI_HOME at a throwaway home — this is exactly what the audit
    // reads live, and it keeps this test's module graph (and the daemon's real home) untouched
    const id = "20261117-010619-59586";
    const home = mkdtempSync(join(tmpdir(), "pane-audit-home-"));
    const logDir = makeLogDir();
    try {
      // spawned 01:06:19; at the round's fresh clock it is minutes past the spawn grace, but its pane
      // launcher (wrapper + caller) is still opening the pane — the incident killed exactly this run
      writeFileSync(join(logDir, `${id}.status`), statusJson(id, 59586));
      loadStatusesCached(logDir); // warm the cached view with the pane-less copy (the daemon's default workers source)
      mkdirSync(join(home, "state", "pane-exec"), { recursive: true });
      // the record's own stamps are minutes old (its pane opened long ago on real time): what can spare
      // the run is only that its launcher's pids are still alive at the last look before the stop
      const rec = { id, kind: "worker", caller: 4100, wrapper: 4200, openedMs: S0 - 120_000, startedMs: S0 - 120_000 };
      writeFileSync(join(home, "state", "pane-exec", `${id}.json`), JSON.stringify(rec));
      const script = join(tmpdir(), `pane-audit-spare-round-${process.pid}.mts`);
      writeFileSync(
        script,
        `import { auditLaunches } from ${JSON.stringify(join(import.meta.dirname!, "pane-audit.ts"))};
const [logDir, id] = process.argv.slice(2);
const S0 = Date.parse("2026-11-17T01:08:22");
const stopped = [];
for (let i = 0; i < 2; i++) {
  await auditLaunches(logDir, {
    // the record's pids are not real processes in this fake world: every side is "dead"
    alive: () => false,
    kill: () => undefined,
    closePane: async () => undefined,
    registered: () => false,
    workers: () => [{ id, startedMs: S0 - 120_000, exec: false, exempt: false }], // minutes past grace on spawn alone
    launcherAlive: (pid) => pid === 4100 || pid === 4200, // wrapper + caller alive: the pane is opening
    stop: async (wid) => void stopped.push(wid),
  }); // the default clock: real time, like the daemon
}
console.log(JSON.stringify(stopped));
`,
        "utf8"
      );
      const r = execFileSync("npx", ["tsx", script, logDir, id], {
        encoding: "utf8",
        env: { ...process.env, PAI_HOME: home },
      });
      expect(JSON.parse(r.trim())).toEqual([]); // spared both rounds: its launcher was still opening the pane
      const lines = readFileSync(join(logDir, "ledger.log"), "utf8").split("\n");
      expect(lines.filter((l) => l.includes("PANE-SPARED") && l.includes(`id=${id}`)).length).toBe(1); // noted once, never a stop
      expect(lines.some((l) => l.includes("pane audit: spared") && l.includes(id))).toBe(true); // the spared line names the run
      expect(lines.some((l) => l.includes("PANE-UNLAUNCHED"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
      try {
        unlinkSync(join(tmpdir(), `pane-audit-spare-round-${process.pid}.mts`));
      } catch {
        /* the child left nothing behind */
      }
    }
  });

  it("saveStatus invalidates the cache: two writes of equal size in the same millisecond — the second is seen", () => {
    const logDir = makeLogDir();
    const id = "20261116-202608-55117";
    try {
      // saveStatus renames atomically; on a coarse-granularity filesystem both writes share one mtime tick.
      // Stamp the file back to that tick after each write: an mtimeMs+size key would keep the first parse,
      // and with it every cached reader's stale view (the capacity gate, the reaper, supervision).
      const path = join(logDir, `${id}.status`);
      const stamp = new Date(1794859549000);
      const base = { id, label: "cache-key", pid: 55117, state: "running" as const, started: "2026-11-16 20:26:08", updated: "2026-11-16 20:26:08", cwd: logDir, term: "", provider: "x", model: "m", turns: 0, tools: 0, last: "", rc: null, secs: null };
      saveStatus(logDir, { ...base, last: "first" });
      utimesSync(path, stamp, stamp);
      loadStatusesCached(logDir); // warm the cache with the first write
      expect(loadStatusesCached(logDir).find((s) => s.id === id)?.last).toBe("first");
      saveStatus(logDir, { ...base, last: "second" }); // same byte count (both labels are 5 chars), same tick
      utimesSync(path, stamp, stamp);
      expect(loadStatusesCached(logDir).find((s) => s.id === id)?.last).toBe("second"); // the writer invalidated its entry
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("auditTick looks only at recent workers", () => {
  const NOW = Date.parse("2026-11-24T12:00:00");
  const stamp = (ms: number): string => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const status = (id: string, state: string, atMs: number): string =>
    JSON.stringify({ id, pid: 1, runPid: 1, state, started: stamp(atMs), updated: stamp(atMs), turns: 1, tools: 0, origin: "spawn" });

  it("2000 old ended workers and 3 live ones: 3 verdicts, under 50 ms, old verdicts pruned, nothing reported twice", async () => {
    const logDir = makeLogDir();
    try {
      const old = NOW - 5 * 86_400_000;
      for (let i = 0; i < 2000; i++) {
        const id = `old-${i}`;
        const f = join(logDir, `${id}.status`);
        writeFileSync(f, status(id, "done", old));
        utimesSync(f, old / 1000, old / 1000);
      }
      // a stale verdict file from earlier passes, for a worker long gone
      writeFileSync(join(logDir, "pane-audit.json"), JSON.stringify({ at: "x", verdicts: [{ id: "old-1", kind: "worker", mark: "NO PANE" }] }));
      writeFileSync(join(logDir, "pane-audit-told.json"), JSON.stringify({ "old-1": "NO PANE" }));
      const live = ["live-a", "live-b", "live-c"];
      for (const id of live) {
        const f = join(logDir, `${id}.status`);
        writeFileSync(f, status(id, "running", NOW - 3_600_000));
        utimesSync(f, (NOW - 1000) / 1000, (NOW - 1000) / 1000);
      }
      const seen: string[] = [];
      const run = (): Promise<unknown> =>
        auditTick(logDir, {} as never, {
          now: () => new Date(NOW),
          tabs: async () => new Map([["unrelated", "1:1"]]),
          launches: async () => undefined,
          registry: () => [],
          running: () => true,
          ownSession: () => "",
          stop: async (id) => void seen.push(id),
        });
      await run(); // warm: the first pass reads the directory
      const t0 = performance.now();
      await run();
      const ms = performance.now() - t0;
      const { readAudit } = await import("./pane-audit.js");
      const ids = readAudit(logDir).map((v) => v.id);
      expect(ids.every((id) => live.includes(id))).toBe(true);
      expect(ids.some((id) => id.startsWith("old-"))).toBe(false);
      expect(JSON.parse(readFileSync(join(logDir, "pane-audit-told.json"), "utf8"))["old-1"]).toBeUndefined();
      expect(ms).toBeLessThan(50);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("a violation reported once is not recorded again on later passes", async () => {
    const logDir = makeLogDir();
    try {
      const id = "live-x";
      writeFileSync(join(logDir, `${id}.status`), status(id, "running", NOW - 3_600_000));
      const pass = (): Promise<unknown> =>
        auditTick(logDir, {} as never, {
          now: () => new Date(NOW),
          tabs: async () => new Map([["unrelated", "1:1"]]),
          launches: async () => undefined,
          registry: () => [{ session: "gone", worker: id, opened: "2026-11-24 10:00:00", scope: "s" } as never],
          running: () => true,
          ownSession: () => "",
          reopen: async () => { throw new Error("no host"); },
          stop: async () => undefined,
        });
      for (let i = 0; i < 5; i++) await pass();
      const ledger = join(logDir, "ledger.jsonl");
      let text = "";
      try { text = readFileSync(ledger, "utf8"); } catch { /* ledger elsewhere */ }
      const { ledgerPath } = await import("./paths.js");
      try { text = readFileSync(ledgerPath(logDir), "utf8"); } catch { /* none */ }
      expect((text.match(/PANE-VIOLATION/g) ?? []).length).toBeLessThanOrEqual(1);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
