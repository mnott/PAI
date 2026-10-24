/**
 * Pane registry + close-ended tests. iTerm and tmux are never touched:
 * child_process is mocked, closing goes through injected PaneOps.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nextSession = 0;
vi.mock("node:child_process", () => ({
  execFileSync: () => {
    throw new Error("mocked: no ps/plutil/tmux");
  },
  spawn: () => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => void; end: () => void } };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const sess = `SESS-${++nextSession}`;
    proc.stdin = {
      write: () => undefined,
      end: () => {
        setTimeout(() => {
          proc.stdout.emit("data", Buffer.from(`|${sess}`));
          proc.emit("close", 0);
        }, 5);
      },
    };
    return proc;
  },
}));

import { closeRegisteredIterm, closeEndedPanes, closeOwnPane, closeSelfPane, workerEnded, closePaneForWorker, loadRegistry, openPaneForWorker, realPaneOps, type PaneOps } from "./pane.js";
import { saveStatus, type WorkerStatus } from "./status.js";
import { writePaneRunStatus } from "./pane-run.js";
import { scopeKey } from "./scope.js";
import { ledgerPath } from "./paths.js";
import type { WorkersConfig } from "./config.js";

const config = { pane: { fontSize: 13, autoExitSecs: 10 } } as unknown as WorkersConfig;
const TERM = "w5t0p0:D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
let dir = "";
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-panereg-"));
  process.env.PAI_WORKER_PROFILE = join(dir, "profile.json");
  process.env.ITERM_SESSION_ID = TERM;
  delete process.env.TMUX;
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const fakeOps = (over: Partial<PaneOps> = {}): PaneOps & { closedIterm: string[]; closedTmux: string[] } => {
  const closedIterm: string[] = [];
  const closedTmux: string[] = [];
  return {
    closedIterm,
    closedTmux,
    listIterm: async () => [],
    closeIterm: async (id) => (closedIterm.push(id), true),
    listTmux: () => [],
    closeTmux: (id) => (closedTmux.push(id), true),
    ...over,
  };
};

describe("closeRegisteredIterm", () => {
  it("never runs osascript for a session PAI did not open; closes a registered one", async () => {
    const calls: string[][] = [];
    const run = (async (_script: string, args: string[]) => (calls.push(args), { stdout: "closed\n", stderr: "" })) as never;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const uid = "D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
    expect(await closeRegisteredIterm(uid, run, () => false)).toBe(false);
    expect(calls).toEqual([]);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("refusing to close");
    expect(await closeRegisteredIterm(uid, run, () => true)).toBe(true);
    expect(calls).toEqual([[uid]]);
  });
});

describe("a pane's own launch record vouches for it", () => {
  it("closes an unregistered session its pane-exec wrapper recorded; a foreign one is still refused", async () => {
    const calls: string[][] = [];
    const run = (async (_script: string, args: string[]) => (calls.push(args), { stdout: "closed\n", stderr: "" })) as never;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const home = join(dir, "home");
    process.env.PAI_HOME = home;
    mkdirSync(join(home, "state", "pane-exec"), { recursive: true });
    const mine = "A1B2C3D4-0000-4000-8000-000000000001";
    writeFileSync(join(home, "state", "pane-exec", "w-pooled.json"), JSON.stringify({ id: "w-pooled", kind: "worker", caller: 1, wrapper: 2, session: `w0t0p1:${mine}`, startedMs: 1 }));
    // the real registry check (no override): no registry entry, only the record
    expect(await closeRegisteredIterm(mine, run)).toBe(true);
    expect(await closeRegisteredIterm("D38D3E5D-19E8-4FE5-A78A-26E8E571FE27", run)).toBe(false);
    expect(calls).toEqual([[mine]]);
  });

  it("a record without a session vouches for nothing", async () => {
    const run = (async () => ({ stdout: "closed\n", stderr: "" })) as never;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const home = join(dir, "home2");
    process.env.PAI_HOME = home;
    mkdirSync(join(home, "state", "pane-exec"), { recursive: true });
    writeFileSync(join(home, "state", "pane-exec", "w-tmux.json"), JSON.stringify({ id: "w-tmux", kind: "worker", caller: 1, wrapper: 2, startedMs: 1 }));
    expect(await closeRegisteredIterm("A1B2C3D4-0000-4000-8000-000000000002", run)).toBe(false);
  });
});

describe("pane registry", () => {
  it("keeps all three entries when three workers open panes at once", async () => {
    const ids = ["20260929-203824-58109", "20260929-203825-59308", "20260929-203826-59992"];
    await Promise.all(ids.map((id) => openPaneForWorker(dir, config, id, TERM, {})));
    const reg = loadRegistry(dir);
    expect(reg.map((e) => e.worker).sort()).toEqual(ids);
    expect(new Set(reg.map((e) => e.session)).size).toBe(3);
  });

  it("still reads a legacy shared list", () => {
    mkdirSync(join(dir, "panes"), { recursive: true });
    writeFileSync(
      join(dir, "panes", "SCOPE.json"),
      JSON.stringify([{ session: "S1", worker: "20260929-100000-1", opened: "2026-09-29 10:00:00" }])
    );
    expect(loadRegistry(dir, "SCOPE").map((e) => e.session)).toEqual(["S1"]);
  });
});

describe("closing panes", () => {
  const seed = (worker: string, session: string, opened: string) => {
    mkdirSync(join(dir, "panes", "SCOPE"), { recursive: true });
    writeFileSync(join(dir, "panes", "SCOPE", `${worker}.json`), JSON.stringify({ session, worker, opened }));
  };

  it("closes by worker id and drops only that entry", async () => {
    seed("20260929-100000-1", "S1", "2026-09-29 10:00:00");
    seed("20260929-100001-2", "S2", "2026-09-29 10:00:01");
    const ops = fakeOps();
    expect(await closePaneForWorker(dir, "20260929-100001-2", ops)).toBe(true);
    expect(ops.closedIterm).toEqual(["S2"]);
    expect(readdirSync(join(dir, "panes", "SCOPE"))).toEqual(["20260929-100000-1.json"]);
  });

  it("--close-ended: closes ended, keeps running, iTerm and tmux, dry run touches nothing", async () => {
    seed("20260929-100000-1", "S1", "2026-09-29 10:00:00"); // ended, registered
    seed("20260929-100001-2", "S2", "2026-09-29 10:00:01"); // running, registered
    const over: Partial<PaneOps> = {
      listIterm: async () => [
        { id: "S1", name: "node pai worker follow 20260929-100000-1 --auto-exit 10" }, // also registered: once
        { id: "S9", name: "node pai worker follow 20260929-100009-9 --auto-exit 10" }, // ended, unregistered
        { id: "S8", name: "zsh" },
      ],
      listTmux: () => [
        { id: "%3", command: "node pai worker follow 20260929-100003-3 --auto-exit 10" }, // ended
        { id: "%4", command: "node pai worker follow 20260929-100001-2 --auto-exit 10" }, // running
      ],
    };
    const ended = (w: string) => w !== "20260929-100001-2";
    // S2 (running) is open in iTerm too; a registered-but-gone session is only forgotten
    over.listIterm = async () => [
      { id: "S2", name: "zsh" },
      { id: "S1", name: "node pai worker follow 20260929-100000-1 --auto-exit 10" },
      { id: "S9", name: "node pai worker follow 20260929-100009-9 --auto-exit 10" },
    ];
    seed("20260929-100005-5", "GONE", "2026-09-29 10:00:05"); // ended, session no longer in iTerm

    const dry = fakeOps(over);
    const d = await closeEndedPanes(dir, ended, true, dry);
    expect(d.closed.length).toBe(3);
    expect(dry.closedIterm).toEqual([]);
    expect(dry.closedTmux).toEqual([]);
    expect(existsSync(join(dir, "panes", "SCOPE", "20260929-100000-1.json"))).toBe(true);

    const live = fakeOps(over);
    const r = await closeEndedPanes(dir, ended, false, live);
    expect(live.closedIterm.sort()).toEqual(["S1", "S9"]);
    expect(live.closedTmux).toEqual(["%3"]);
    expect(r.kept.join("\n")).toContain("20260929-100001-2");
    expect(readdirSync(join(dir, "panes", "SCOPE"))).toEqual(["20260929-100001-2.json"]);
  });

  it("--close-ended sweeps leftover ended pane-run panes too, keeps a running one", async () => {
    seed("pane-20261020-140300-1", "SP1", "2026-10-20 14:03:00"); // ended pane run, still open
    seed("pane-20261020-140301-2", "SP2", "2026-10-20 14:03:01"); // running pane run
    seed("20260929-100000-1", "S1", "2026-09-29 10:00:00"); // ended worker
    const paneRun = (id: string, state: "running" | "done" | "failed") =>
      writePaneRunStatus(dir, { kind: "pane", id, label: "x", cwd: dir, pid: process.pid, started: "2026-10-20 14:03:00", startedMs: Date.now(), state, log: join(dir, `${id}.log`) });
    paneRun("pane-20261020-140300-1", "failed");
    paneRun("pane-20261020-140301-2", "running");
    saveStatus(dir, { id: "20260929-100000-1", label: "x", cwd: dir, provider: "p", state: "done" } as unknown as WorkerStatus);
    const ended = (w: string) => workerEnded(dir, w);
    const over: Partial<PaneOps> = {
      listIterm: async () => [
        { id: "SP1", name: "node pai worker follow pane-20261020-140300-1" },
        { id: "SP2", name: "node pai worker follow pane-20261020-140301-2" }, // running pane run: kept
        { id: "S1", name: "node pai worker follow 20260929-100000-1" },
      ],
    };
    const live = fakeOps(over);
    const r = await closeEndedPanes(dir, ended, false, live);
    expect(live.closedIterm.sort()).toEqual(["S1", "SP1"]);
    expect(r.kept.join("\n")).toContain("pane-20261020-140301-2");
    expect(readdirSync(join(dir, "panes", "SCOPE"))).toEqual(["pane-20261020-140301-2.json"]);
  });
});

describe("ended workers keep their pane until the next pane replaces it", () => {
  const seed = (worker: string, session: string) => {
    const scope = scopeKey(TERM);
    mkdirSync(join(dir, "panes", scope), { recursive: true });
    writeFileSync(join(dir, "panes", scope, `${worker}.json`), JSON.stringify({ session, worker, opened: "2026-10-10 10:00:00" }));
  };
  const status = (id: string, state: string) =>
    saveStatus(dir, { id, label: "x", cwd: dir, provider: "p", state } as unknown as WorkerStatus);

  it("saveStatus of an ended worker leaves its pane registered and open", async () => {
    const closed: string[] = [];
    const spy = vi.spyOn(realPaneOps, "closeIterm").mockImplementation(async (id) => (closed.push(id), true));
    seed("20261010-100000-1", "SA");
    status("20261010-100000-1", "killed");
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toEqual([]);
    expect(loadRegistry(dir).map((e) => e.worker)).toEqual(["20261010-100000-1"]);
    spy.mockRestore();
  });

  it("opening the next pane closes the scope's ended panes and keeps running ones", async () => {
    const closed: string[] = [];
    const spy = vi.spyOn(realPaneOps, "closeIterm").mockImplementation(async (id) => (closed.push(id), true));
    seed("20261010-100000-1", "S-DONE");
    seed("20261010-100001-2", "S-RUN");
    status("20261010-100000-1", "done");
    status("20261010-100001-2", "running");
    await openPaneForWorker(dir, config, "20261010-100002-3", TERM, {});
    expect(closed).toEqual(["S-DONE"]);
    // the mocked split script reports no live sessions, yet S-RUN's worker runs: its entry stays
    expect(loadRegistry(dir).map((e) => e.worker).sort()).toEqual(["20261010-100001-2", "20261010-100002-3"]);
    spy.mockRestore();
  });

  it("closeOwnPane closes this iTerm session by its uuid", async () => {
    const ops = fakeOps();
    // ps is mocked to fail: the follow command of this session is unknown, never a reason to refuse
    expect(await closeOwnPane({ ITERM_SESSION_ID: TERM }, ops)).toBe(true);
    expect(ops.closedIterm).toEqual(["D38D3E5D-19E8-4FE5-A78A-26E8E571FE27"]);
    expect(await closeOwnPane({}, ops)).toBe(false);
  });
});

describe("sibling replacement", () => {
  const put = (id: string, extra: Record<string, unknown>) =>
    saveStatus(dir, { id, label: "x", cwd: dir, provider: "p", ...extra } as unknown as WorkerStatus);

  it("siblings of one orchestrator share a scope whatever the caller's env says", () => {
    const a = scopeKey("w9t1p0:FEE3A386-C5E3-4237-A661-F7CE44CF8602");
    process.env.ITERM_SESSION_ID = "w2t0p0:AAAAAAAA-0000-0000-0000-000000000000";
    expect(scopeKey("w9t1p0:FEE3A386-C5E3-4237-A661-F7CE44CF8602")).toBe(a);
  });

  it("done, failed, killed and lost count as ended", () => {
    for (const state of ["done", "failed", "killed", "lost"]) {
      put(`w-${state}`, { state, pid: process.pid });
      expect(workerEnded(dir, `w-${state}`)).toBe(true);
    }
  });

  it("running with a live pid, or without a pid, or unknown is not ended", () => {
    put("w-live", { state: "running", pid: process.pid });
    put("w-nopid", { state: "running" });
    expect(workerEnded(dir, "w-live")).toBe(false);
    expect(workerEnded(dir, "w-nopid")).toBe(false);
    expect(workerEnded(dir, "w-missing")).toBe(false);
  });

  it("queued with a live pid is not ended; with a dead pid it is", () => {
    put("w-queued", { state: "queued", pid: process.pid });
    expect(workerEnded(dir, "w-queued")).toBe(false);
    put("w-queued-dead", { state: "queued", pid: 2 ** 22 + 23456 });
    expect(workerEnded(dir, "w-queued-dead")).toBe(true);
  });

  it("a ghost 'running' status whose pid is dead counts as ended", () => {
    put("w-ghost", { state: "running", pid: 2 ** 22 + 12345 });
    expect(workerEnded(dir, "w-ghost")).toBe(true);
  });
});

describe("pane identity is explicit", () => {
  it("closeSelfPane closes only the uuid of the env it is given", async () => {
    const closed: string[] = [];
    const ops = { ...realPaneOps, closeIterm: async (u: string) => { closed.push(u); return true; } } as PaneOps;
    const prev = process.env.ITERM_SESSION_ID;
    process.env.ITERM_SESSION_ID = "w0t0p0:AMBIENT-UUID";
    try {
      expect(await closeSelfPane({}, ops)).toBe(false);
      expect(closed).toEqual([]);
      expect(await closeSelfPane({ ITERM_SESSION_ID: "w0t0p0:GIVEN-UUID" }, ops)).toBe(true);
      expect(closed).toEqual(["GIVEN-UUID"]);
    } finally {
      if (prev === undefined) delete process.env.ITERM_SESSION_ID; else process.env.ITERM_SESSION_ID = prev;
    }
  });
});

describe("closeEndedPanes: pane opened during the iTerm listing", () => {
  const seed = (worker: string, session: string, opened: string) => {
    mkdirSync(join(dir, "panes", "SCOPE"), { recursive: true });
    writeFileSync(join(dir, "panes", "SCOPE", `${worker}.json`), JSON.stringify({ session, worker, opened }));
  };
  it("logs caller, run, session and reason for a stale drop", async () => {
    seed("20260929-100001-1", "GONE", "2026-09-29 10:00:01");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await closeEndedPanes(dir, () => true, false, fakeOps({ listIterm: async () => [{ id: "OTHER", name: "zsh" }] }));
    const log = err.mock.calls.map((c) => String(c[0])).join("");
    err.mockRestore();
    expect(log).toContain("[pane-registry] drop caller=closeEndedPanes run=20260929-100001-1 session=GONE reason=stale");
  });
  it("keeps an entry registered after the listing started (pooled run race)", async () => {
    const ops = fakeOps({
      listIterm: async () => {
        // the slow osascript listing runs; meanwhile another process opens and registers a pane
        seed("20260929-100077-7", "NEW", "2026-09-29 10:00:77");
        return [{ id: "OTHER", name: "zsh" }]; // listing taken before NEW existed
      },
    });
    await closeEndedPanes(dir, () => true, false, ops);
    expect(existsSync(join(dir, "panes", "SCOPE", "20260929-100077-7.json"))).toBe(true);
  });
});

describe("a live worker's entry is never dropped by a sibling", () => {
  const status = (id: string, state: string, pid: number) =>
    saveStatus(dir, { id, label: "x", cwd: dir, provider: "p", state, pid } as unknown as WorkerStatus);
  const seedLive = (worker: string, session: string) => {
    const scope = scopeKey(TERM);
    mkdirSync(join(dir, "panes", scope), { recursive: true });
    writeFileSync(join(dir, "panes", scope, `${worker}.json`), JSON.stringify({ session, worker, opened: "2026-10-24 12:37:25" }));
  };

  it("49979 (queued behind admission) keeps its entry while 49395 opens and its pane is not in the split listing", async () => {
    seedLive("20261024-123725-49979", "S-49979");
    status("20261024-123725-49979", "queued", process.pid);
    await openPaneForWorker(dir, config, "20261024-123724-49395", TERM, {});
    expect(loadRegistry(dir).map((e) => e.worker).sort()).toEqual(["20261024-123724-49395", "20261024-123725-49979"]);
  });

  it("a stale-session sweep keeps a live worker's entry and forgets an ended one", async () => {
    seedLive("20261024-123725-49979", "S-LIVE");
    seedLive("20261024-123724-49395", "S-DONE");
    await closeEndedPanes(dir, (w) => w === "20261024-123724-49395", false, fakeOps({ listIterm: async () => [{ id: "OTHER", name: "zsh" }] }));
    expect(loadRegistry(dir).map((e) => e.worker)).toEqual(["20261024-123725-49979"]);
  });

  it("a pane-exec worker with a live wrapper is not ended, whatever pid its status holds", () => {
    const home = join(dir, "home3");
    process.env.PAI_HOME = home;
    mkdirSync(join(home, "state", "pane-exec"), { recursive: true });
    status("w-adm", "queued", 2 ** 22 + 777);
    expect(workerEnded(dir, "w-adm")).toBe(true);
    writeFileSync(join(home, "state", "pane-exec", "w-adm.json"), JSON.stringify({ id: "w-adm", kind: "worker", caller: 1, wrapper: process.pid, startedMs: 1 }));
    expect(workerEnded(dir, "w-adm")).toBe(false);
  });

  it("every drop is ledgered PANE-ENTRY-DROP with run, session, caller and reason", async () => {
    seedLive("20261024-123724-49395", "S-DONE");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await closePaneForWorker(dir, "20261024-123724-49395", fakeOps());
    const ledger = readFileSync(ledgerPath(dir), "utf8");
    expect(ledger).toMatch(/PANE-ENTRY-DROP.*run=20261024-123724-49395.*session=S-DONE.*caller=closePaneForWorker.*reason=/);
  });
});
