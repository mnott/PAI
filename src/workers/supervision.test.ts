/**
 * Tests for supervision.ts — the condition detection and the restart guard,
 * over a fake ledger: plain WorkerStatus objects, no processes, no real clock.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkersSection } from "./config.js";
import { workersLogDir } from "./paths.js";
import {
  baselineState,
  detectSupervisionEvents,
  eventId,
  filterUndelivered,
  loadSupervisionState,
  markDelivered,
  pruneState,
  runSupervisionTick,
  saveSupervisionState,
  stallMinutesFromEnv,
  supervisionEventsPath,
  type SupervisionEvent,
  type SupervisionState,
} from "./supervision.js";
import type { WorkerStatus } from "./status.js";

const NOW = new Date("2026-09-18T01:00:00");

/** A status stamp `mins` before the test clock. */
function stampAgo(now: Date, mins: number): string {
  const d = new Date(now.getTime() - mins * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

interface FakeOptions {
  id?: string;
  state?: WorkerStatus["state"];
  rc?: number | null;
  updatedMinsAgo?: number;
  turns?: number;
  spawnerSession?: string | null;
  itermSession?: string | null;
  parent?: string;
  pid?: number;
  origin?: WorkerStatus["origin"];
  label?: string;
}

/** One ledger row with everything defaulted to "healthy and owned". */
function fake(o: FakeOptions = {}): WorkerStatus {
  return {
    id: o.id ?? "20260918-010000-100",
    pid: o.pid ?? 4242,
    label: "fix black buttons",
    cwd: "/repo",
    term: "",
    provider: "p1",
    model: "m1",
    state: o.state ?? "running",
    started: stampAgo(NOW, 30),
    updated: stampAgo(NOW, o.updatedMinsAgo ?? 0),
    turns: o.turns ?? 3,
    tools: 5,
    last: "",
    rc: o.rc ?? null,
    secs: null,
    ...(o.spawnerSession === undefined
      ? { spawnerSession: "claude-sess-1" }
      : o.spawnerSession
        ? { spawnerSession: o.spawnerSession }
        : {}),
    ...(o.itermSession ? { session: { id: o.itermSession, name: "orchestrator" } } : {}),
    ...(o.parent ? { parent: o.parent, stage: "implement" } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
    ...(o.label !== undefined ? { label: o.label } : {}),
  };
}

const detect = (statuses: WorkerStatus[], stallMin = 10) =>
  detectSupervisionEvents(statuses, {
    stallMs: stallMin * 60_000,
    now: NOW,
    // pid 0 stands in for a dead runner, every other pid reads alive
    isAlive: (pid: number) => pid !== 0,
  });

describe("condition detection", () => {
  it("reports a clean finish as finished rc=0", () => {
    const [ev] = detect([fake({ state: "done", rc: 0 })]);
    expect(ev).toBeTruthy();
    expect(ev.kind).toBe("finished");
    expect(ev.rc).toBe(0);
    expect(ev.text).toContain("finished rc=0");
    expect(ev.text).toContain("pai worker replay");
    expect(ev.session).toBe("claude-sess-1");
  });

  it("reports a non-zero rc as failed", () => {
    const [ev] = detect([fake({ state: "failed", rc: 2 })]);
    expect(ev.kind).toBe("failed");
    expect(ev.rc).toBe(2);
    expect(ev.text).toContain("failed rc=2");
  });

  it("reports an error state as failed even with rc null", () => {
    const [ev] = detect([fake({ state: "failed", rc: null })]);
    expect(ev.kind).toBe("failed");
    expect(ev.rc).toBeNull();
  });

  it("reports a killed worker as failed exactly like any other bad end", () => {
    const [ev] = detect([fake({ state: "killed", rc: 143 })]);
    expect(ev.kind).toBe("failed");
    expect(ev.rc).toBe(143);
  });

  it("reports a runner whose pid vanished mid-running as failed", () => {
    const [ev] = detect([fake({ state: "running", pid: 0, updatedMinsAgo: 5 })]);
    expect(ev.kind).toBe("failed");
    expect(ev.rc).toBeNull();
    expect(ev.text).toContain("runner gone");
  });

  it("does not report a dead pid inside the grace window (status write racing the tick)", () => {
    expect(detect([fake({ state: "running", pid: 0, updatedMinsAgo: 0 })])).toHaveLength(0);
  });

  it("reports a running worker with no new turns past the threshold as stalled", () => {
    const [ev] = detect([fake({ state: "running", updatedMinsAgo: 14, turns: 3 })]);
    expect(ev.kind).toBe("stalled");
    expect(ev.stalledMin).toBe(14);
    expect(ev.text).toContain("stalled 14m no turns");
  });

  it("stays quiet below the threshold", () => {
    expect(detect([fake({ state: "running", updatedMinsAgo: 9 })])).toHaveLength(0);
  });

  it("honours a custom threshold", () => {
    expect(detect([fake({ state: "running", updatedMinsAgo: 3 })], 2)).toHaveLength(1);
    expect(detect([fake({ state: "running", updatedMinsAgo: 3 })], 5)).toHaveLength(0);
  });

  it("never reports the interactive chat pane as stalled, however idle", () => {
    // origin "chat" is the pane, not a task worker: idle is its healthy state
    expect(detect([fake({ origin: "chat", turns: 0, updatedMinsAgo: 816 })])).toHaveLength(0);
    // pre-`origin` status files: the unlabeled no-turns shape reads as chat too
    expect(detect([fake({ label: "unlabeled", turns: 0, updatedMinsAgo: 816 })])).toHaveLength(0);
  });

  it("still reports a task worker with the same idle timestamp as stalled", () => {
    const [ev] = detect([fake({ origin: "spawn", turns: 0, updatedMinsAgo: 816 })]);
    expect(ev.kind).toBe("stalled");
    expect(ev.stalledMin).toBe(816);
  });

  it("keeps finished and failed detection for the interactive chat pane", () => {
    const [fin] = detect([fake({ origin: "chat", state: "done", rc: 0 })]);
    expect(fin.kind).toBe("finished");
    const [bad] = detect([fake({ origin: "chat", state: "running", pid: 0, updatedMinsAgo: 20 })]);
    expect(bad.kind).toBe("failed");
    expect(bad.text).toContain("runner gone");
  });

  it("ignores workers no session owns", () => {
    expect(detect([fake({ state: "failed", rc: 1, spawnerSession: null })])).toHaveLength(0);
  });

  it("falls back to the iTerm uuid as owner when no spawner session is known", () => {
    const [ev] = detect([
      fake({ state: "done", rc: 0, spawnerSession: null, itermSession: "iterm-uuid-9" }),
    ]);
    expect(ev.session).toBe("iterm-uuid-9");
  });

  it("supervises chain stages individually", () => {
    const evs = detect([
      fake({ id: "chain-1", state: "done", rc: 0, parent: "chain-root" }),
      fake({ id: "chain-2", state: "failed", rc: 1, parent: "chain-root" }),
      fake({ id: "chain-3", state: "running", updatedMinsAgo: 20, parent: "chain-root" }),
    ]);
    expect(evs.map((e) => e.kind)).toEqual(["finished", "failed", "stalled"]);
  });
});

describe("dedup and the restart guard", () => {
  it("a stall re-arms only when a new turn arrives", () => {
    const stalledOnce = detect([fake({ turns: 3, updatedMinsAgo: 12 })]);
    const stalledAgainSameTurns = detect([fake({ turns: 3, updatedMinsAgo: 13 })]);
    expect(stalledAgainSameTurns[0].id).toBe(stalledOnce[0].id); // one event

    const resumedThenStalled = detect([fake({ turns: 4, updatedMinsAgo: 12 })]);
    expect(resumedThenStalled[0].id).not.toBe(stalledOnce[0].id); // new turn, new event
  });

  it("filterUndelivered drops ids the state already carries", () => {
    const evs = detect([fake({ state: "done", rc: 0 })]);
    const state = { delivered: { [evs[0].worker]: [evs[0].id] } };
    expect(filterUndelivered(evs, state)).toHaveLength(0);
  });

  it("a persisted state survives a restart and replays nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-supervision-"));
    try {
      // prime: the ledger knows the worker before it turns terminal, so the
      // finish is an observed transition, not pre-existing history
      await runSupervisionTick(dir, {
        now: NOW,
        isAlive: () => true,
        statuses: [fake({ state: "running" })],
        push: async () => false,
      });
      const first = await runSupervisionTick(dir, {
        now: NOW,
        isAlive: () => true,
        statuses: [fake({ state: "done", rc: 0 })],
        push: async () => false,
      });
      expect(first.events).toHaveLength(1);

      // the "restart": a fresh process reloads the same state file
      const { state } = loadSupervisionState(join(dir, "supervision", "state.json"));
      const second = filterUndelivered(
        detectSupervisionEvents([fake({ state: "done", rc: 0 })], {
          stallMs: 10 * 60_000,
          now: NOW,
          isAlive: () => true,
        }),
        state
      );
      expect(second).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a first run adopts already-terminal workers instead of replaying history", () => {
    const statuses = [
      fake({ id: "old-1", state: "done", rc: 0 }),
      fake({ id: "old-2", state: "failed", rc: 1 }),
      fake({ id: "live-1", state: "running" }),
    ];
    const state = baselineState(statuses);
    expect(state.delivered["old-1"]).toContain(eventId("old-1", "finished"));
    expect(state.delivered["old-2"]).toContain(eventId("old-2", "failed"));
    expect(state.delivered["live-1"]).toBeUndefined();
    expect(filterUndelivered(detect(statuses), state)).toHaveLength(0);
  });

  it("pruneState forgets workers the ledger no longer lists", () => {
    const state = { delivered: { gone: ["x"], here: ["y"] } };
    const pruned = pruneState(state, [fake({ id: "here" })]);
    expect(pruned.delivered["gone"]).toBeUndefined();
    expect(pruned.delivered["here"]).toHaveLength(1);
  });
});

describe("tick delivery", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-supervision-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tick = (statuses: WorkerStatus[], push?: () => Promise<boolean>) =>
    runSupervisionTick(dir, {
      now: NOW,
      isAlive: () => true,
      statuses,
      ...(push ? { push: async () => push() } : {}),
    });

  /** A first tick that sees the worker running, so the later terminal tick is
   *  an observed transition — the fresh-state baseline adopts pre-existing
   *  terminal workers instead of reporting them. */
  const prime = async (id: string, push?: () => Promise<boolean>) =>
    tick([fake({ id, state: "running" })], push);

  it("appends one JSON line per event to the owner's events file", async () => {
    await prime("w-fin");
    const r = await tick([fake({ id: "w-fin", state: "done", rc: 0 })], async () => false);
    expect(r.events).toHaveLength(1);
    const line = JSON.parse(
      readFileSync(supervisionEventsPath(dir, "claude-sess-1"), "utf8").trim()
    ) as SupervisionEvent;
    expect(line.id).toBe("w-fin#finished");
    expect(line.text).toBe(r.events[0].text);
  });

  it("a failed push still leaves the event delivered via its file line", async () => {
    await prime("w-fail");
    const r = await tick([fake({ id: "w-fail", state: "failed", rc: 3 })], async () => false);
    expect(r.events).toHaveLength(1);
    expect(r.pushed).toHaveLength(0);
    const again = await tick([fake({ id: "w-fail", state: "failed", rc: 3 })], async () => false);
    expect(again.events).toHaveLength(0); // append-once holds even when push failed
  });

  it("a successful push is counted and not re-detected", async () => {
    await prime("w-push");
    const r = await tick([fake({ id: "w-push", state: "done", rc: 0 })], async () => true);
    expect(r.pushed).toHaveLength(1);
    const again = await tick([fake({ id: "w-push", state: "done", rc: 0 })], async () => true);
    expect(again.events).toHaveLength(0);
    expect(again.pushed).toHaveLength(0);
  });

  it("later ticks see only new transitions", async () => {
    await tick([fake({ id: "w-live", state: "running" })]);
    const finished = await tick([fake({ id: "w-live", state: "done", rc: 0 })]);
    expect(finished.events).toHaveLength(1);
    const repeat = await tick([fake({ id: "w-live", state: "done", rc: 0 })]);
    expect(repeat.events).toHaveLength(0);
  });

  it("a push that throws is treated as not delivered", async () => {
    await prime("w-throw");
    const r = await tick(
      [fake({ id: "w-throw", state: "done", rc: 0 })],
      () => Promise.reject(new Error("aibroker gone"))
    );
    expect(r.events).toHaveLength(1);
    expect(r.pushed).toHaveLength(0);
  });
});

describe("stallMinutesFromEnv", () => {
  it("defaults to 10 and survives broken values", () => {
    expect(stallMinutesFromEnv({})).toBe(10);
    expect(stallMinutesFromEnv({ PAI_WORKER_STALL_MINUTES: "" })).toBe(10);
    expect(stallMinutesFromEnv({ PAI_WORKER_STALL_MINUTES: "abc" })).toBe(10);
    expect(stallMinutesFromEnv({ PAI_WORKER_STALL_MINUTES: "-5" })).toBe(10);
  });

  it("reads a positive override", () => {
    expect(stallMinutesFromEnv({ PAI_WORKER_STALL_MINUTES: "3" })).toBe(3);
    expect(stallMinutesFromEnv({ PAI_WORKER_STALL_MINUTES: "45" })).toBe(45);
  });
});

describe("state persistence shapes", () => {
  it("round-trips through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-supervision-"));
    try {
      const path = join(dir, "supervision", "state.json");
      saveSupervisionState(path, { delivered: { w: ["w#failed"] } });
      const loaded = loadSupervisionState(path);
      expect(loaded.fresh).toBe(false);
      expect(loaded.state.delivered["w"]).toEqual(["w#failed"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a damaged state file as fresh rather than crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-supervision-"));
    try {
      writeFileSync(join(dir, "state.json"), "{not json", "utf8");
      expect(loadSupervisionState(join(dir, "state.json")).fresh).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("markDelivered adds without duplicating", () => {
    const state: SupervisionState = { delivered: {} };
    const ev: SupervisionEvent = {
      id: "x#failed",
      ts: "",
      kind: "failed",
      worker: "x",
      label: "l",
      session: "s",
      rc: 1,
      stalledMin: null,
      text: "t",
    };
    markDelivered(state, [ev, ev]);
    expect(state.delivered["x"]).toHaveLength(1);
  });
});

describe("config safety — supervision never rewrites the config", () => {
  // The 2026-09-18 incident: with the daemon running, the live config was
  // repeatedly replaced by a schema-shaped dump while supervision ticks ran.
  // Supervision is read-only over the config; these tests pin that down.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-supervision-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the config byte-identical across ticks that deliver events", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          socketPath: "/tmp/pai.sock",
          indexIntervalSecs: 86400,
          storageBackend: "sqlite",
          identity: { selfEmails: ["owner@example.ch"] },
          workers: {
            enabled: true,
            active: null,
            providers: {},
            classes: {},
            mcpSets: {},
            pane: { enabled: false, fontSize: 13, autoExitSecs: 10 },
            logDir: join(dir, "logs"),
            routing: { order: [], cooldownMinutes: 30, retryOnQuota: true },
            tree: { maxDepth: 2, maxChildren: 4 },
            fallback: null,
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    const before = readFileSync(configPath, "utf8");

    // the scheduler wiring's exact read: config → logDir → tick
    const logDir = workersLogDir(readWorkersSection(configPath).workers);
    // several ticks under load: a stall, a failure, a clean finish
    await runSupervisionTick(logDir, {
      now: NOW,
      isAlive: () => true,
      statuses: [fake({ id: "w-a", state: "running", updatedMinsAgo: 20 })],
    });
    await runSupervisionTick(logDir, {
      now: NOW,
      isAlive: () => false,
      statuses: [fake({ id: "w-a", state: "failed", rc: 1 })],
    });
    await runSupervisionTick(logDir, {
      now: NOW,
      isAlive: () => true,
      statuses: [fake({ id: "w-b", state: "done", rc: 0 })],
    });

    const after = readFileSync(configPath, "utf8");
    // byte-identical — no reload/save cycle, no reformatting, nothing
    expect(after).toBe(before);
    // and never the schema-shaped dump the incident produced
    expect(after).not.toContain("socketPath: string");
    expect(after).not.toContain("indexIntervalSecs: int");
    // the ticks really ran: their state lives under the logDir, not the config
    expect(existsSync(join(logDir, "supervision", "state.json"))).toBe(true);
  });
});
