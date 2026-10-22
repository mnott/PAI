/** The pane auditor: injected iTerm listing, registry and processes; nothing touches iTerm. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeFinishedPanes, auditLaunches, auditPanes, auditTick, listItermTabs, markOf, readAudit, renderPaneAudit, type TabMap } from "./pane-audit.js";
import type { LaunchRecord } from "./pane-exec.js";
import { loadRegistry, saveEntry, type PaneEntry } from "./pane.js";
import type { Messenger } from "./run-events.js";

const H = "D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
const P1 = "AAAAAAAA-0000-4000-8000-000000000001";
const P2 = "BBBBBBBB-0000-4000-8000-000000000002";
const entry = (worker: string, session: string, host = H): PaneEntry => ({ session, worker, opened: "x", host });
const tabs = (o: Record<string, string>): TabMap => new Map(Object.entries(o));

describe("auditPanes", () => {
  const procs = [{ id: "w-1", kind: "worker" as const }];
  it("pane in the starting tab: ok", () => {
    expect(auditPanes(procs, [entry("w-1", P1)], tabs({ [H]: "1:2", [P1]: "1:2" }))[0].mark).toBe("ok");
  });
  it("pane under 40x6: SMALL, not NO PANE", () => {
    const sizes = new Map([[P1, { cols: 26, rows: 5 }]]);
    expect(auditPanes(procs, [entry("w-1", P1)], tabs({ [H]: "1:2", [P1]: "1:2" }), undefined, sizes)[0].mark).toBe("SMALL");
  });
  it.each(["NOT SELECTED", "MINIMISED"] as const)("pane running but %s: marked, host tab matches", (mark) => {
    const sizes = new Map([[P1, { cols: 80, rows: 20, mark }]]);
    expect(auditPanes(procs, [entry("w-1", P1)], tabs({ [H]: "1:2", [P1]: "1:2" }), undefined, sizes)[0].mark).toBe(mark);
  });
  it("a worker started without a pane shows NO PANE with the reason", () => {
    const v = auditPanes([{ ...procs[0], noPaneReason: "no attached terminal found" }], [], tabs({ [H]: "1:2" }))[0];
    expect(v).toMatchObject({ mark: "NO PANE" });
    expect(v.why).toContain("no attached terminal found");
  });
  it("no registry entry: NO PANE", () => {
    expect(auditPanes(procs, [], tabs({ [H]: "1:2" }))[0].mark).toBe("NO PANE");
  });
  it("pane gone while the process runs: NO PANE", () => {
    expect(auditPanes(procs, [entry("w-1", P1)], tabs({ [H]: "1:2" }))[0]).toMatchObject({ mark: "NO PANE" });
  });
  it("pane in another tab or window: WRONG TAB", () => {
    expect(auditPanes(procs, [entry("w-1", P1)], tabs({ [H]: "1:2", [P1]: "9:1" }))[0].mark).toBe("WRONG TAB");
  });
  it("ended pane run whose pane is still open: STILL OPEN", () => {
    const now = Date.parse("2026-10-20T02:10:00Z");
    const v = auditPanes([{ id: "pane-1", kind: "pane", startedMs: now - 60000, ended: true }], [entry("pane-1", P1)], tabs({ [H]: "1:2", [P1]: "1:2" }), now)[0];
    expect(v.mark).toBe("STILL OPEN");
    expect(v.why).toContain("still open");
  });
  it("ended pane run whose pane closed (or was never recorded) is ok, never NO PANE", () => {
    const now = Date.parse("2026-10-20T02:10:00Z");
    const ended = [{ id: "pane-1", kind: "pane" as const, startedMs: now - 60000, ended: true }];
    expect(auditPanes(ended, [entry("pane-1", P1)], tabs({ [H]: "1:2" }), now)[0].mark).toBe("ok");
    expect(auditPanes(ended, [], tabs({ [H]: "1:2" }), now)[0].mark).toBe("ok");
  });
  it("ended pane run within the grace (closing takes a few seconds): ok", () => {
    const now = Date.parse("2026-10-20T02:00:40Z");
    expect(auditPanes([{ id: "pane-1", kind: "pane", startedMs: now - 6000, ended: true }], [entry("pane-1", P1)], tabs({ [H]: "1:2", [P1]: "1:2" }), now)[0].mark).toBe("ok");
  });
  it("host from the process when the entry has none", () => {
    const e: PaneEntry = { session: P1, worker: "w-1", opened: "x" };
    expect(auditPanes([{ ...procs[0], host: `w0t0p0:${H}` }], [e], tabs({ [H]: "1:2", [P1]: "3:3" }))[0].mark).toBe("WRONG TAB");
  });
});

describe("start grace", () => {
  const T = tabs({ [H]: "1:2" });
  const now = Date.parse("2026-10-20T02:00:40Z");
  it("process started 6 s ago, pane not listed: ok", () => {
    expect(auditPanes([{ id: "w-1", kind: "worker", startedMs: now - 6000 }], [entry("w-1", P1)], T, now)[0].mark).toBe("ok");
    expect(auditPanes([{ id: "w-1", kind: "worker", startedMs: now - 6000 }], [], T, now)[0].mark).toBe("ok");
  });
  it("old process but pane registered 5 s ago: ok", () => {
    const e = { ...entry("w-1", P1), opened: "2026-10-20 02:00:35" };
    expect(auditPanes([{ id: "w-1", kind: "worker", startedMs: now - 600000 }], [e], T, now)[0].mark).toBe("ok");
  });
  it("past the grace: NO PANE", () => {
    const e = { ...entry("w-1", P1), opened: "2026-10-20 01:50:00" };
    expect(auditPanes([{ id: "w-1", kind: "worker", startedMs: now - 60000 }], [e], T, now)[0].mark).toBe("NO PANE");
  });
});

describe("host tab of every kind", () => {
  const T = tabs({ [H]: "1:2", [P1]: "1:2", [P2]: "1:2" });
  it("worker, plan run and pane run with a recorded host: host tab filled, ok", () => {
    const procs = [
      { id: "w-1", kind: "worker" as const },
      { id: "plan-1", kind: "plan" as const },
      { id: "pane-1", kind: "pane" as const },
    ];
    const v = auditPanes(procs, [entry("w-1", P1), entry("plan-1", P2), entry("pane-1", P1)], T);
    expect(v.map((x) => [x.mark, x.hostTab])).toEqual([["ok", "1:2"], ["ok", "1:2"], ["ok", "1:2"]]);
  });
  it("no host recorded anywhere: HOST UNKNOWN, not ok", () => {
    const e: PaneEntry = { session: P1, worker: "pane-1", opened: "x" };
    expect(auditPanes([{ id: "pane-1", kind: "pane" }], [e], T)[0]).toMatchObject({ mark: "HOST UNKNOWN" });
  });
  it("host not in the iTerm listing: HOST UNKNOWN", () => {
    expect(auditPanes([{ id: "w-1", kind: "worker" }], [entry("w-1", P1)], tabs({ [P1]: "1:2" }))[0].mark).toBe("HOST UNKNOWN");
  });
  it("the registry file keeps the host", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-audit-reg-"));
    try {
      saveEntry(dir, { session: P1, worker: "pane-1", opened: "2026-01-01 00:00:00", scope: "s", host: H });
      expect(loadRegistry(dir)[0].host).toBe(H);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listItermTabs", () => {
  it("parses session -> window:tab", async () => {
    const m = await listItermTabs(async () => ({ stdout: `${H}\t1:2\n${P1}\t1:2\n` }));
    expect(m.get(P1)).toBe("1:2");
  });
});

describe("auditTick", () => {
  let dir: string;
  const sent: string[] = [];
  const msg: Messenger = { toSession: async (o, t) => (sent.push(`S:${o.iterm}:${t}`), true), toPailot: async (t) => (sent.push(`P:${t}`), true) };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-audit-"));
    sent.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = () =>
    auditTick(dir, msg, {
      tabs: async () => tabs({ [H]: "1:2", [P2]: "9:1" }),
      procs: () => [
        { id: "w-bad", kind: "worker" },
        { id: "plan-x", kind: "plan" },
      ],
      registry: () => [entry("w-bad", P2), entry("plan-x", "CCCCCCCC-0000-4000-8000-000000000003")],
      launches: async () => [],
    });
  const noLaunches = { launches: async () => [] };
  const ledger = () => readFileSync(join(dir, "ledger.log"), "utf8");

  it("records, marks and writes each violation once, to the ledger only", async () => {
    expect((await run()).map((x) => x.mark)).toEqual(["ok", "ok"]); // first failed check only confirms
    const v = await run();
    expect(v.map((x) => x.mark)).toEqual(["WRONG TAB", "NO PANE"]);
    expect(ledger()).toMatch(/PANE-VIOLATION.*w-bad/);
    expect(markOf(readAudit(dir), "w-bad")).toBe("WRONG TAB");
    await run();
    expect(ledger().match(/PANE-VIOLATION/g)?.length).toBe(2); // not repeated
    expect(sent.length).toBe(0); // never a session, never PAILot
  });
  it("a failure that clears after one check is never reported", async () => {
    await run();
    await auditTick(dir, msg, { tabs: async () => tabs({ [H]: "1:2", [P2]: "1:2" }), procs: () => [{ id: "w-bad", kind: "worker" }], registry: () => [entry("w-bad", P2)], ...noLaunches });
    await run();
    expect(existsSync(join(dir, "ledger.log"))).toBe(false);
  });
  it("unreadable iTerm: no verdict", async () => {
    expect(await auditTick(dir, msg, { tabs: async () => Promise.reject(new Error("x")), procs: () => [], ...noLaunches })).toEqual([]);
  });
  it("renders process -> pane -> tab", async () => {
    await run();
    expect(renderPaneAudit(await run())).toMatch(/WRONG TAB\s+worker w-bad\s+pane BBBBBBBB.*tab 9:1.*host tab 1:2/);
  });
  it("there is no reopening: a running worker whose pane is gone is a ledger line, nothing else", async () => {
    const tick = () => auditTick(dir, msg, { tabs: async () => tabs({ [H]: "1:2" }), procs: () => [{ id: "w-1", kind: "worker" }], registry: () => [entry("w-1", P1)], running: () => true, ...noLaunches });
    await tick();
    expect((await tick())[0].mark).toBe("NO PANE");
    expect(ledger()).toMatch(/PANE-VIOLATION.*w-1/);
    expect(ledger()).not.toMatch(/REOPEN/);
    expect(sent.length).toBe(0);
  });
  it("a worker running without its pane is stopped through the normal end path, ledgered PANE-STOPPED, once", async () => {
    const stopped: string[] = [];
    const tick = () => auditTick(dir, msg, { tabs: async () => tabs({ [H]: "1:2" }), procs: () => [{ id: "w-1", kind: "worker" }], registry: () => [], running: () => true, stop: async (id) => void stopped.push(id), ...noLaunches });
    await tick(); // confirming check: nothing yet
    expect(stopped).toEqual([]);
    await tick();
    expect(stopped).toEqual(["w-1"]);
    expect(ledger()).toMatch(/PANE-STOPPED.*w-1/);
    await tick();
    expect(stopped).toEqual(["w-1"]);
  });
  it("status turned done between the pane check and the report: no violation", async () => {
    let alive = true;
    const tick = () => auditTick(dir, msg, { tabs: async () => tabs({ [H]: "1:2" }), procs: () => [{ id: "w-1", kind: "worker" }], registry: () => [], running: () => alive, ...noLaunches });
    await tick(); // confirms
    alive = false; // the worker ended after the pane vanished
    expect((await tick())[0].mark).toBe("ok");
    expect(existsSync(join(dir, "ledger.log"))).toBe(false);
  });
  it("pane closed 10 s ago, process exiting: no violation", async () => {
    const now = new Date(1_700_000_000_000);
    const tick = () =>
      auditTick(dir, msg, {
        tabs: async () => tabs({ [H]: "1:2" }),
        procs: () => [{ id: "w-1", kind: "worker", startedMs: now.getTime() - 600_000, endedMs: now.getTime() - 10_000 }],
        registry: () => [],
        now: () => now,
        running: () => true,
        ...noLaunches,
      });
    await tick();
    expect((await tick())[0].mark).toBe("ok");
  });
});

describe("auditLaunches: the bug detector for the pane-owns-the-process rule", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-auditl-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const NOW = new Date(1_700_000_000_000);
  const rec = (o: Partial<LaunchRecord> = {}): LaunchRecord => ({ id: "w-1", kind: "worker", caller: 1, wrapper: 100, child: 200, startedMs: NOW.getTime() - 600_000, ...o });
  const rig = (alive: number[]) => {
    const killed: string[] = [];
    const closed: string[] = [];
    return { killed, closed, deps: { alive: (p?: number) => p !== undefined && alive.includes(p), kill: (pid: number, sig: string, group: boolean) => void killed.push(`${pid}:${sig}:${group}`), closePane: async (id: string) => void closed.push(id), workers: () => [] } };
  };
  const ledger = () => readFileSync(join(dir, "ledger.log"), "utf8");

  it("a launcher-run process in order (wrapper and child alive) is never reported", async () => {
    const r = rig([100, 200]);
    expect(await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => null }, NOW)).toEqual([]);
    expect(r.killed).toEqual([]);
    expect(existsSync(join(dir, "ledger.log"))).toBe(false);
  });
  it("a finished launch (exit file, both gone) is history, not a finding", async () => {
    const r = rig([]);
    expect(await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => ({ id: "w-1", code: 0, endedMs: NOW.getTime() - 5000 }) }, NOW)).toEqual([]);
  });
  it("child gone while the pane lives: the wrapper is killed and the pane closed, ledger only", async () => {
    const r = rig([100]);
    const f = await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => null }, NOW);
    expect(f.map((x) => x.kind)).toEqual(["orphan-wrapper"]);
    expect(r.killed).toEqual(["100:SIGKILL:false"]);
    expect(r.closed).toEqual(["w-1"]);
    expect(ledger()).toMatch(/PANE-ORPHAN.*side=wrapper/);
  });
  it("child ended long ago but the wrapper still holds the pane: closed", async () => {
    const r = rig([100]);
    const f = await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => ({ id: "w-1", code: 0, endedMs: NOW.getTime() - 60_000 }) }, NOW);
    expect(f.map((x) => x.kind)).toEqual(["orphan-wrapper"]);
    expect(r.closed).toEqual(["w-1"]);
  });
  it("a failed run's wrapper lingers like a clean one: an orphan past the same linger", async () => {
    const r = rig([100]);
    expect(await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => ({ id: "w-1", code: 1, endedMs: NOW.getTime() - 2000 }) }, NOW)).toEqual([]);
    expect(r.killed).toEqual([]);
    const f = await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => ({ id: "w-1", code: 1, endedMs: NOW.getTime() - 60_000 }) }, NOW);
    expect(f.map((x) => x.kind)).toEqual(["orphan-wrapper"]);
  });
  it("the wrapper is still closing the pane (exit file seconds old): left alone", async () => {
    const r = rig([100]);
    expect(await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => ({ id: "w-1", code: 0, endedMs: NOW.getTime() - 2000 }) }, NOW)).toEqual([]);
  });
  it("pid reuse: a live pid that is no longer the launch's own process is never signalled", async () => {
    const r = rig([100, 200]);
    const f = await auditLaunches(dir, { ...r.deps, owns: () => false, records: () => [rec()], exit: () => null }, NOW);
    expect(f).toEqual([]);
    expect(r.killed).toEqual([]);
    expect(r.closed).toEqual([]);
  });
  it("session reuse: an old orphan whose iTerm session now carries a newer launch is dropped, not acted on", async () => {
    const r = rig([100, 300, 400]);
    const old = rec({ session: "w0t0p0:AAAA" });
    const fresh = rec({ id: "w-2", wrapper: 300, child: 400, session: "w0t0p0:AAAA", startedMs: NOW.getTime() - 5000 });
    const f = await auditLaunches(dir, { ...r.deps, records: () => [old, fresh], exit: () => null }, NOW);
    expect(f).toEqual([]);
    expect(r.killed).toEqual([]);
    expect(r.closed).toEqual([]);
  });
  it("wrapper (the pane) gone while the child runs: the child's group is killed", async () => {
    const r = rig([200]);
    const f = await auditLaunches(dir, { ...r.deps, records: () => [rec()], exit: () => null }, NOW);
    expect(f.map((x) => x.kind)).toEqual(["orphan-child"]);
    expect(r.killed).toEqual(["200:SIGKILL:true"]);
  });
  it("a running worker that did not go through the launcher is noted once; one recorded as no-terminal is not", async () => {
    const r = rig([]);
    const old = NOW.getTime() - 600_000;
    const workers = () => [
      { id: "w-bare", startedMs: old, exec: false, exempt: false },
      { id: "w-noterm", startedMs: old, exec: false, exempt: true },
      { id: "w-ok", startedMs: old, exec: true, exempt: false },
      { id: "w-pooled", startedMs: old, exec: false, exempt: false },
      { id: "w-young", startedMs: NOW.getTime() - 1000, exec: false, exempt: false },
    ];
    const stopped: string[] = [];
    const deps = { ...r.deps, records: () => [], workers, registered: (id: string) => id === "w-pooled", stop: async (id: string) => void stopped.push(id) };
    const f = await auditLaunches(dir, deps, NOW);
    expect(f.map((x) => x.id)).toEqual(["w-bare"]);
    expect(ledger()).toMatch(/PANE-UNLAUNCHED.*w-bare/);
    expect(stopped).toEqual(["w-bare"]); // it does not run on without a pane
    expect(ledger()).toMatch(/PANE-STOPPED.*w-bare/);
    expect(await auditLaunches(dir, deps, NOW)).toEqual([]); // told once
    expect(r.killed).toEqual([]);
  });
  it("a pool-served worker whose pane is registered is not unlaunched", async () => {
    const r = rig([]);
    const stopped: string[] = [];
    const workers = () => [{ id: "w-pooled", startedMs: NOW.getTime() - 600_000, exec: false, exempt: false }];
    expect(await auditLaunches(dir, { ...r.deps, records: () => [], workers, registered: () => true, stop: async (id) => void stopped.push(id) }, NOW)).toEqual([]);
    expect(stopped).toEqual([]);
  });
});

describe("closeFinishedPanes", () => {
  const NOW = new Date(1_700_000_000_000);
  const dir = "/nonexistent-pane-logs"; // every dependency is injected
  const entry = (w: string) => ({ session: `s-${w}`, worker: w, opened: "2026-01-01T00:00:00Z" });
  const exitOf = (code: number, agoMs: number) => () => ({ id: "x", code, endedMs: NOW.getTime() - agoMs });
  const rig = (alive: number[], ids: string[]) => {
    const closed: string[] = [];
    const killed: number[] = [];
    return {
      closed,
      killed,
      deps: (exit: ReturnType<typeof exitOf> | (() => null)) => ({
        registry: () => ids.map(entry),
        record: (id: string) => ({ id, kind: "worker", caller: 1, wrapper: 100, child: 200, startedMs: 1 }),
        exit,
        alive: (p?: number) => p !== undefined && alive.includes(p),
        kill: (p: number) => void killed.push(p),
        closePane: async (id: string) => void closed.push(id),
      }),
    };
  };

  it("a failed pane closes after the same linger as a clean one", async () => {
    const r = rig([100], ["w-f"]);
    expect((await closeFinishedPanes(dir, r.deps(exitOf(1, 3_000)), NOW)).closed).toEqual([]);
    const res = await closeFinishedPanes(dir, r.deps(exitOf(1, 9_000)), NOW);
    expect(res.closed).toEqual(["w-f"]);
    expect(r.closed).toEqual(["w-f"]);
    expect(r.killed).toEqual([100]); // the held wrapper of an older build
  });
  it("a clean pane closes after the short linger", async () => {
    const r = rig([], ["w-c"]);
    expect((await closeFinishedPanes(dir, r.deps(exitOf(0, 3_000)), NOW)).closed).toEqual([]);
    expect((await closeFinishedPanes(dir, r.deps(exitOf(0, 9_000)), NOW)).closed).toEqual(["w-c"]);
  });
  it("a pane whose process is alive is never closed, whatever the exit file says", async () => {
    const r = rig([200], ["w-live"]);
    const res = await closeFinishedPanes(dir, r.deps(exitOf(1, 999_000)), NOW);
    expect(res.closed).toEqual([]);
    expect(res.kept).toEqual(["w-live"]);
    expect(r.closed).toEqual([]);
    expect(r.killed).toEqual([]);
  });
  it("a child gone without an exit record is left to the launcher audit", async () => {
    const r = rig([], ["w-x"]);
    expect((await closeFinishedPanes(dir, r.deps(() => null), NOW)).closed).toEqual([]);
  });
  it("dry run closes nothing", async () => {
    const r = rig([], ["w-c"]);
    expect((await closeFinishedPanes(dir, r.deps(exitOf(0, 99_000)), NOW, true)).closed).toEqual(["w-c"]);
    expect(r.closed).toEqual([]);
  });
});
