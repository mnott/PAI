import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLaunches, auditTick, type LaunchAuditDeps } from "./pane-audit.js";
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
