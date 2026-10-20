/** The pane auditor: injected iTerm listing, registry and processes; nothing touches iTerm. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditPanes, auditTick, listItermTabs, markOf, readAudit, renderPaneAudit, type TabMap } from "./pane-audit.js";
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
  it("no registry entry: NO PANE", () => {
    expect(auditPanes(procs, [], tabs({ [H]: "1:2" }))[0].mark).toBe("NO PANE");
  });
  it("pane gone while the process runs: NO PANE", () => {
    expect(auditPanes(procs, [entry("w-1", P1)], tabs({ [H]: "1:2" }))[0]).toMatchObject({ mark: "NO PANE" });
  });
  it("pane in another tab or window: WRONG TAB", () => {
    expect(auditPanes(procs, [entry("w-1", P1)], tabs({ [H]: "1:2", [P1]: "9:1" }))[0].mark).toBe("WRONG TAB");
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
    });

  it("records, marks and reports each violation once", async () => {
    expect((await run()).map((x) => x.mark)).toEqual(["ok", "ok"]); // first failed check only confirms
    expect(sent.length).toBe(0);
    const v = await run();
    expect(v.map((x) => x.mark)).toEqual(["WRONG TAB", "NO PANE"]);
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toMatch(/PANE-VIOLATION.*w-bad/);
    expect(markOf(readAudit(dir), "w-bad")).toBe("WRONG TAB");
    expect(sent.filter((s) => s.startsWith("S:")).length).toBe(2);
    expect(sent.filter((s) => s.startsWith("P:")).length).toBe(2);
    await run();
    expect(sent.length).toBe(4); // not repeated
  });
  it("a failure that clears after one check is never reported", async () => {
    await run();
    await auditTick(dir, msg, { tabs: async () => tabs({ [H]: "1:2", [P2]: "1:2" }), procs: () => [{ id: "w-bad", kind: "worker" }], registry: () => [entry("w-bad", P2)] });
    await run();
    expect(sent.length).toBe(0);
  });
  it("unreadable iTerm: no verdict", async () => {
    expect(await auditTick(dir, msg, { tabs: async () => Promise.reject(new Error("x")), procs: () => [] })).toEqual([]);
  });
  it("renders process -> pane -> tab", async () => {
    await run();
    expect(renderPaneAudit(await run())).toMatch(/WRONG TAB\s+worker w-bad\s+pane BBBBBBBB.*tab 9:1.*host tab 1:2/);
  });
});
