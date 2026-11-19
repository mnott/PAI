/**
 * preempt.ts — a `--now` run on a local provider goes first. The other local
 * workers on that provider are paused at once (reason "preempted by <id>", so
 * the router also aborts the request each has in flight and re-sends it on
 * resume), they stop counting against the provider's cap while paused — only
 * for the now run's group: a normal waiter still counts them, so the freed slot
 * goes to the preemptor (the capacity gate ignores exactly the workers paused by
 * a live urgent run) and never to an unrelated run — and they resume exactly when
 * the now run ends. A now run that stays queued past PREEMPT_ABORT_MS after pausing
 * them never took their slots: the daemon's watchdog resumes them and logs
 * PREEMPT-ABORT (abortStuckPreemptions), so workers are never held paused for a
 * preemptor that stays queued. Paused time is added to their deadline
 * (active-time.ts preemptedMsOf).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getProviderOrNative, isLocalProvider, readWorkersSection } from "./config.js";
import { DEFAULT_CAPACITY, capacityOf, liveQueue, queueDir, resolveCap, writeTicket } from "./capacity.js";
import { readUrgencyFor } from "./urgency.js";
import { setWorkerPaused, setWorkerPriority } from "./engine-control.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { isLive, ownsPidCached, loadStatuses, loadStatusesCached, loadLiveStatusesCached, loadStatus, saveStatus, slotLent, type WorkerStatus } from "./status.js";

/** Slots free on `provider` for an urgent (preempting) run: its cap minus every live running worker that holds one — a paused victim of a live preemptor frees its slot and is not counted; one whose preemptor is gone counts again until the sweep releases it. A released preemption goes back through the capacity gate's queue like any other run, never over the cap (a slot its victim held during the pause may already have gone to another run). Unlimited when uncapped. */
function roomOn(statuses: WorkerStatus[], provider: string): number {
  // a paused victim frees its slot only for a preemptor that is live; with the preemptor gone the pause is the sweep's to release, and until then the worker keeps counting against the cap.
  // The gate reads caps through admitCap (capacity.ts); providerCap adds the conversationSlots hold-down, which must not shrink what preemption may lend: a local engine serving N requests at once still has N slots for the now run's group.
  let raw = undefined as number | undefined;
  try {
    const w = readWorkersSection().workers;
    const p = w.providers[provider];
    if (p) raw = resolveCap(p.maxConcurrent, isLocalProvider(p.baseUrl), capacityOf(w.capacity).localDefaultCap);
  } catch {
    raw = undefined;
  }
  if (raw === undefined) return Number.MAX_SAFE_INTEGER;
  const holding = statuses.filter(
    (s) => s.provider === provider && s.state === "running" && !slotLent(s) && isLive(s) && !(s.paused && !s.pausedBy) && !(s.paused && s.pausedBy && isLive(statuses.find((x) => x.id === s.pausedBy) ?? ({} as WorkerStatus))),
  ).length;
  return raw - holding;
}

type RoomFn = (statuses: WorkerStatus[], provider: string) => number;

/** Claim one of the provider's free slots for a resume; false when none is left. */
function takeRoom(room: Map<string, number>, all: WorkerStatus[], provider: string, roomFn: RoomFn): boolean {
  const left = room.get(provider) ?? roomFn(all, provider);
  if (left <= 0) {
    room.set(provider, left);
    return false;
  }
  room.set(provider, left - 1);
  return true;
}

/**
 * A preempted worker whose pause ends but has no free slot (the slot it held went to another run during
 * the pause): its pause is closed and it waits for a slot at the capacity gate's queue — `front`, so it
 * keeps its place at the head — instead of running over the cap. A "running" status with no slot is what
 * the gate's own wait looks like, so the worker's next admission poll (the reroute guard) sees it queued
 * and picks the wait up; when a slot frees the capacity gate flips it back to "running". The sweep keeps
 * its ticket alive (the gate drops dead ones): `pai worker ps` shows it waiting, not paused.
 */
function parkAtGate(logDir: string, s: WorkerStatus, by: string, now: number): boolean {
  const dir = queueDir(logDir, s.provider);
  mkdirSync(dir, { recursive: true });
  writeTicket(join(dir, s.id), `${s.runPid ?? s.pid} front @${now}`);
  return setWorkerPaused(logDir, s.id, false, `preempt:${by}`, undefined, now);
}

/**
 * The one explicit resume of an operator pause (`pai worker resume`, the MCP tool, the cockpit/pane button). Least impact on other
 * jobs: a resume never takes a slot a running job holds and never preempts. With a free slot and nobody waiting it runs at once;
 * otherwise it re-enters the queue as a waiter (ahead of the others of its own priority class, behind everything that is already
 * first by priority), stays paused until it is its turn and the next FREE slot opens (admitResumedWaiters). Only priority "now"
 * (an explicit choice) may preempt. Returns false when it was not paused.
 */
export function resumeWorker(logDir: string, id: string, who = "cli", now = Date.now(), roomFn: RoomFn = roomOn, agingMs = DEFAULT_CAPACITY.agingMs): boolean {
  const s = loadStatus(logDir, id);
  if (!s?.paused) return false;
  if (s.pausedBy || s.state !== "running") return setWorkerPaused(logDir, id, false, who, undefined, now);
  const dir = queueDir(logDir, s.provider);
  const waiting = liveQueue(logDir, s.provider).filter((x) => x !== id).length;
  if (roomFn(loadStatuses(logDir), s.provider) > 0 && waiting === 0) return setWorkerPaused(logDir, id, false, who, undefined, now);
  mkdirSync(dir, { recursive: true });
  const prio = s.priority && s.priority !== "normal" ? ` p:${s.priority}` : "";
  // an "aged" stamp puts it first among the waiters of its own priority class (capacity.ts fairOrder), never ahead of a higher class
  writeTicket(join(dir, s.id), `${s.runPid ?? s.pid} @${now - agingMs - 1}${prio}`);
  appendLedger(ledgerPath(logDir), "WORKER-RESUME-QUEUED", { by: who, who, id, provider: s.provider });
  return true;
}

/**
 * Supervision (daemon, 30 s): a resumed worker waiting in its provider's queue (paused, ticket present) is released when it is the
 * head and a slot is FREE. Never takes a held slot. Returns the ids released.
 */
export const ADMIT_MAX_RELEASES = 50;
export const ADMIT_BUDGET_MS = 1_000;

export function admitResumedWaiters(logDir: string, now = Date.now(), roomFn: RoomFn = roomOn): string[] {
  const out: string[] = [];
  let provs: string[];
  try {
    provs = readdirSync(join(logDir, "queue"));
  } catch {
    return out;
  }
  // ONE scan of the status files per tick, shared by every queue and every ticket (2026-11-18: a re-scan of 7000 files per ticket held the daemon loop for seconds)
  const all = loadStatusesCached(logDir, now);
  const byId = new Map(all.map((s) => [s.id, s]));
  const deadline = performance.now() + ADMIT_BUDGET_MS;
  let steps = 0;
  for (const prov of provs) {
    // in queue order while a slot is free; a head that is not a resumed waiter (a new job) keeps its place and stops the walk
    for (const id of liveQueue(logDir, prov, undefined, all, now)) {
      // hard cap: releases and time per tick; the rest waits for the next sweep
      if (++steps > ADMIT_MAX_RELEASES || performance.now() > deadline) return out;
      const s = byId.get(id);
      if (!s?.paused || s.pausedBy || s.state !== "running") break;
      if (roomFn(all, s.provider) <= 0) break;
      rmSync(join(queueDir(logDir, s.provider), id), { force: true });
      if (setWorkerPaused(logDir, id, false, "queue", undefined, now)) {
        out.push(id);
        // the released worker holds a slot now: the next ticket's room check must see it
        const fresh = loadStatus(logDir, id);
        if (fresh) {
          byId.set(id, fresh);
          const i = all.findIndex((x) => x.id === id);
          if (i >= 0) all[i] = fresh;
        }
      }
    }
  }
  return out;
}

/** Whether the preemption pause of `s` (paused with pausedBy set) has ended: its preemptor is gone from the ledger or no longer live. */
function preemptorGone(s: WorkerStatus, all: WorkerStatus[]): boolean {
  const by = all.find((x) => x.id === s.pausedBy);
  return !by || !isLive(by);
}

/**
 * The sweep's one pass over a preempted worker `s`: resume it when its preemptor is gone and a slot is
 * free; hand it to another urgent worker still running on its provider; park it at the capacity gate's
 * queue (front, pause closed) while no slot is free. Returns "resumed" or "queued" for the ledger line.
 */
function sweepOne(logDir: string, s: WorkerStatus, all: WorkerStatus[], room: Map<string, number>, roomFn: RoomFn, now: number): "resumed" | "queued" | undefined {
  // pausedBy comes from the FRESH file: an operator pause that took the worker over since `all` was read
  // cleared it, and that pause must stay (the sweep may not release what the operator holds)
  const cur = loadStatus(logDir, s.id);
  if (!cur?.paused || !cur.pausedBy || (s.pausedBy && cur.pausedBy !== s.pausedBy)) return undefined;
  const by = cur.pausedBy;
  if (!preemptorGone(cur, all)) return undefined;
  const next = otherUrgent(all.filter((x) => isLive(x)), cur.provider, by, cur.id);
  if (next) {
    if (cur.pausedBy === by) {
      cur.pausedBy = next.id;
      saveStatus(logDir, cur, new Date(now), true);
    }
    return undefined;
  }
  // a paused victim holds no slot (roomOn does not count it), so its release must claim one: without room
  // it waits at the gate's queue (front) — the pause is over either way, it just never runs over the cap.
  if (!takeRoom(room, all, cur.provider, roomFn)) return parkAtGate(logDir, cur, by, now) ? "queued" : undefined;
  return setWorkerPaused(logDir, s.id, false, `preempt:${by}`, undefined, now) ? "resumed" : undefined;
}

/** An urgent worker still running or waiting on `provider`, other than `except`. */
function otherUrgent(statuses: WorkerStatus[], provider: string, except: string, victim: string): WorkerStatus | undefined {
  return statuses.find((s) => s.id !== except && s.id !== victim && s.now && s.provider === provider && (s.state === "running" || s.state === "queued"));
}

/** Pause every other running, not yet paused worker on `provider` for the now run `by`; returns the ids paused. */
export function preemptLocal(logDir: string, provider: string, by: string, now = Date.now()): string[] {
  const paused: string[] = [];
  for (const s of loadStatuses(logDir)) {
    // urgent workers never pause each other: they share the engine's slots among themselves
    if (s.id === by || s.now || s.provider !== provider || s.state !== "running" || s.paused) continue;
    try {
      if (setWorkerPaused(logDir, s.id, true, `preempt:${by}`, by, now)) paused.push(s.id);
    } catch {
      /* ended meanwhile */
    }
  }
  return paused;
}

/**
 * End the preemption pause of exactly the workers `by` paused; one the operator paused separately
 * (pausedBy cleared) stays paused. While another urgent worker still runs on the provider the victims stay
 * paused, now preempted by that one. A victim with a free slot resumes into it; one whose slot went to
 * another run meanwhile has its pause closed and waits at the capacity gate's queue (front) — never over
 * the cap. Returns every id whose pause ended (resumed or parked at the gate).
 */
export function resumePreempted(logDir: string, by: string, now = Date.now(), roomFn: RoomFn = roomOn): string[] {
  const released: string[] = [];
  const all = loadStatuses(logDir);
  const room = new Map<string, number>();
  for (const s of all) {
    if (s.pausedBy !== by || (s.state !== "running" && s.state !== "queued") || !loadStatus(logDir, s.id)?.paused) continue;
    try {
      // a queued victim holds no slot: its pause just ends
      if (s.state === "queued") {
        if (setWorkerPaused(logDir, s.id, false, `preempt:${by}`, undefined, now)) released.push(s.id);
        continue;
      }
      // the preemptor ending here counts as gone: its victims are not handed to it (a victim already
      // handed to another urgent worker still keeps that one, so `all` minus this by stays the pool)
      const what = sweepOne(logDir, s, all.filter((x) => x.id !== by), room, roomFn, now);
      if (what) released.push(s.id);
    } catch {
      /* gone */
    }
  }
  return released;
}

/**
 * Make a worker urgent (`pai worker priority <id> now`): its engine requests go first and, on a
 * local provider, the other local workers pause. A queued worker's own gate sees the flag at its
 * next poll, goes to the front and preempts when it is admitted; a running one preempts here.
 * Returns the ids paused now.
 */
export function makeUrgent(logDir: string, id: string, local: boolean, who = "cli", now = Date.now(), windowUntil?: number): string[] {
  const s = loadStatus(logDir, id);
  if (!s) throw new Error(`no worker named "${id}"`);
  if (s.state !== "running" && s.state !== "queued") throw new Error(`worker ${id} is ${s.state}; only a running or queued worker can be made urgent`);
  const from = s.priority ?? "normal";
  // a window's now is tied to it (endExpiredWindowNow gives the old priority back); a manual one is sticky
  if (windowUntil !== undefined) {
    if (!s.now) s.nowFrom = { until: windowUntil, prev: s.priority ?? "normal" };
    else if (s.nowFrom) s.nowFrom.until = windowUntil;
  } else delete s.nowFrom;
  s.now = true;
  s.priority = "high";
  saveStatus(logDir, s, new Date(now), true);
  appendLedger(ledgerPath(logDir), "WORKER-PRIORITY", { who, id, from, to: "now" });
  // urgent workers never pause each other: its own preemption pause ends (an operator pause, pausedBy cleared, stays)
  if (s.paused && s.pausedBy && s.state === "running") {
    try {
      setWorkerPaused(logDir, id, false, "priority-now", undefined, now);
    } catch {
      /* ended meanwhile */
    }
  }
  return s.state === "running" && local ? preemptLocal(logDir, s.provider, id, now) : [];
}

export type PriorityLevel = "high" | "normal" | "low" | "now";

/** `pai worker priority <id> <level>` / worker_priority: "now" makes the worker urgent (makeUrgent); any other level ends its urgency. Returns the previous level and who was paused. */
export function applyPriority(logDir: string, id: string, level: PriorityLevel, who = "cli"): { from: string; paused: string[] } {
  const cur = loadStatus(logDir, id);
  if (!cur) throw new Error(`no worker named "${id}"`);
  if (level === "now") {
    const p = getProviderOrNative(readWorkersSection().workers, cur.provider);
    return { from: cur.now ? "now" : cur.priority ?? "normal", paused: makeUrgent(logDir, id, !!p && isLocalProvider(p.baseUrl), who) };
  }
  const wasNow = cur.now === true;
  const from = setWorkerPriority(logDir, id, level, who);
  if (wasNow) {
    const s = loadStatus(logDir, id);
    if (s) {
      delete s.now;
      delete s.nowFrom;
      saveStatus(logDir, s, new Date(), true);
    }
    resumePreempted(logDir, id);
  }
  return { from: wasNow ? "now" : from, paused: [] };
}

/**
 * Supervision sweep (daemon, every 30 s): a worker paused with "preempted by X" whose X is no longer
 * running or live (killed, crashed, never started) has its pause ended — resumed into a free slot, handed
 * to another urgent worker still running on its provider, or parked at the capacity gate's queue (front,
 * pause closed) when its slot went to another run meanwhile: it waits in line, never runs over the cap.
 * Preemption always gives back what it took. Returns every id whose pause ended this sweep.
 */
export function resumeOrphaned(logDir: string, now = Date.now(), roomFn: RoomFn = roomOn): string[] {
  // the daemon's sweep runs every 30 s over thousands of historical files: only live entries are ever of interest here (a paused worker is running), so the cached live load skips every terminal file's stat, and with nothing paused there is nothing to release — return before touching anything else.
  // The scan is cached, the actions are not: sweepOne re-reads each candidate's fresh file (loadStatus) before it releases a pause, and its pool comes from the same live-only view (a terminal entry is never in it), so no stale copy can act on its own.
  const all = loadLiveStatusesCached(logDir);
  if (!all.some((s) => s.paused && s.pausedBy)) return [];
  const released: string[] = [];
  const room = new Map<string, number>();
  for (const s of all) {
    if (!s.paused || !s.pausedBy) continue;
    try {
      const what = sweepOne(logDir, s, all, room, roomFn, now);
      if (what) released.push(s.id);
    } catch {
      /* ended meanwhile */
    }
  }
  return released;
}

/** A preemptor this long queued after pausing others, with no slot it could take: the watchdog gives their slots back (PREEMPT-ABORT). */
export const PREEMPT_ABORT_MS = 60_000;

/**
 * The watchdog's one pass over a stuck preemption `by`: it paused victims whose slots it then never took —
 * its own admission needs `freed` free slots (the gate ignores exactly the victims that freed them), and after
 * PREEMPT_ABORT_MS with the preemptor still queued and no room, the pause is aborted: every victim of `by`
 * resumes into its slot (no room claim — the slots are their own again) and a PREEMPT-ABORT ledger line says so.
 * A preemptor that started or ended is not stuck; one whose victims an operator took over stays paused (the
 * sweep's rule). Returns the ids released.
 */
/** The wait start (`@<epoch ms>`) a queue ticket carries ("<pid>[ front] [@since] …", capacity.ts); null without one. */
function readTicketSince(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const at = text.trim().split(/\s+/).find((m) => m.startsWith("@"));
  if (!at) return null;
  const v = Number(at.slice(1));
  return Number.isFinite(v) ? v : null;
}

function abortOnePreemption(logDir: string, by: string, all: WorkerStatus[], now: number): string[] {
  // isLive (not ownsPidCached): a watchdog that misreads the live pid as another process would abort a preemption whose run is fine
  const me = all.find((x) => x.id === by);
  if (!me || !isLive(me) || me.state !== "queued") return [];
  // the wait's start rides the queue ticket ("<pid> front @<since>", capacity.ts); the status' copy can lag a poll
  const since = readTicketSince(join(queueDir(logDir, me.provider), by)) ?? me.capacity?.sinceMs ?? Number.NaN;
  if (!Number.isFinite(since) || now - since < PREEMPT_ABORT_MS) return [];
  // the slots it paused must be open for its group (roomOn frees exactly its own victims); if they are not,
  // a run outside the preemption holds them and pausing more would not help — abort anyway: the victims'
  // owner keeps counting them against everyone, and N waits at the gate like any other run.
  const released: string[] = [];
  for (const v of all) {
    if (!v.paused || v.pausedBy !== by || !loadStatus(logDir, v.id)?.paused) continue;
    try {
      // no room claim: a victim resumes into the slot it freed for this run — that loan is revoked
      if (setWorkerPaused(logDir, v.id, false, `preempt-abort:${by}`, undefined, now)) released.push(v.id);
    } catch {
      /* ended meanwhile */
    }
  }
  if (released.length) {
    // the preemptor keeps its ticket and its "front" place at the gate's head: when a slot frees it is admitted like any other run, never over the cap now that every victim holds its own again. The sweep keeps its ticket alive (the gate drops dead ones).
    appendLedger(ledgerPath(logDir), "PREEMPT-ABORT", { id: by, provider: me.provider, resumed: released.join(","), waitedSec: String(Math.floor((now - since) / 1000)) });
  }
  return released;
}

/**
 * Supervision sweep (daemon, every 30 s): a "now" run that paused workers on its provider but stayed queued
 * past PREEMPT_ABORT_MS never took the slots it claimed — give them back and log PREEMPT-ABORT. Without this
 * the queue is deadlocked: paused victims still count against the cap for every other waiter, and the preemptor
 * waits for a slot that only their release would open (2026-11-17: three gyro-l workers held "paused
 * (preempted by …)" for 30 min while its preemptor sat at position 2 of 8). Returns every id whose pause ended.
 */
export function abortStuckPreemptions(logDir: string, now = Date.now()): string[] {
  // the daemon's sweep runs every 30 s over thousands of historical files: only live entries matter (a stuck
  // preemptor is queued and live, its victims are paused and running), so the cached live load skips every terminal file's stat.
  const all = loadLiveStatusesCached(logDir);
  if (!all.some((s) => s.paused && s.pausedBy)) return [];
  const victimsBy = new Map<string, true>();
  for (const v of all) if (v.paused && v.pausedBy) victimsBy.set(v.pausedBy, true);
  const released: string[] = [];
  for (const by of victimsBy.keys()) {
    try {
      released.push(...abortOnePreemption(logDir, by, all, now));
    } catch {
      /* ended meanwhile */
    }
  }
  return released;
}

/** Whether `s`'s session still has an urgency window open that reaches `until` (a cleared or expired window does not). */
function windowOpenFor(s: WorkerStatus, until: number, now: number): boolean {
  return [s.spawnerSession, s.sessionKey].some((k) => !!k && (readUrgencyFor(k, now)?.until ?? 0) >= until);
}

/**
 * A "now" that an urgency window gave is tied to it: once the window expired or was cleared, the worker drops
 * back to the priority it had before and the workers it preempted resume (into free slots). A manual now
 * (no nowFrom) stays. Returns the ids restored.
 */
export function endExpiredWindowNow(logDir: string, now = Date.now(), roomFn: RoomFn = roomOn): string[] {
  const done: string[] = [];
  // the daemon's sweep runs every 30 s over thousands of historical files: only live entries are ever of interest here (isLive below refuses a terminal one), so the cached live load skips every terminal file's stat, and with no window-tied "now" run live there is nothing to end.
  // The scan is cached, the actions are not: every release path re-reads the fresh file (cur?.now) first, so nothing acts on a stale view. ownsPidCached keeps isLive to one ps per running candidate at most.
  const all = loadLiveStatusesCached(logDir);
  if (!all.some((s) => s.now && s.nowFrom)) return [];
  for (const s of all) {
    if (!s.now || !s.nowFrom || !isLive(s, ownsPidCached) || windowOpenFor(s, s.nowFrom.until, now)) continue;
    const cur = loadStatus(logDir, s.id);
    if (!cur?.now || !cur.nowFrom) continue;
    cur.priority = cur.nowFrom.prev;
    delete cur.now;
    delete cur.nowFrom;
    saveStatus(logDir, cur, new Date(now), true);
    appendLedger(ledgerPath(logDir), "WORKER-PRIORITY", { who: "urgency-window", id: s.id, from: "now", to: cur.priority ?? "normal" });
    resumePreempted(logDir, s.id, now, roomFn);
    done.push(s.id);
  }
  return done;
}

/** Cause recorded in `pausedBy` by a pause that belongs to a machine freeze (not to an urgent worker). */
export const FREEZE_CAUSE = "freeze";

/**
 * Safety net (router tick, SCHED-UNPAUSE-ORPHAN): `worker` is paused with a recorded cause (pausedBy) that is over —
 * no urgent (`now`) worker is alive any more (the cause worker ended, or lost its now) and, for a freeze cause, no
 * freeze is active. The pause is lifted and ledgered. An operator pause (no cause) is never touched. Returns true when lifted.
 */
export function releaseOrphanPause(logDir: string, worker: string, frozen: boolean, now = Date.now()): boolean {
  const s = loadStatus(logDir, worker);
  if (!s?.paused || !s.pausedBy || (s.state !== "running" && s.state !== "queued")) return false;
  if (s.pausedBy === FREEZE_CAUSE ? frozen : loadLiveStatusesCached(logDir).some((x) => x.now && x.id !== worker && isLive(x) && (x.state === "running" || x.state === "queued"))) return false;
  if (!setWorkerPaused(logDir, worker, false, "sched-orphan", undefined, now)) return false;
  appendLedger(ledgerPath(logDir), "SCHED-UNPAUSE-ORPHAN", { id: worker, was: s.pausedBy });
  return true;
}

/** Thaw: lift exactly the pauses the freeze caused (pausedBy = freeze). Returns the ids lifted. */
export function releaseFreezePauses(logDir: string, now = Date.now()): string[] {
  const out: string[] = [];
  for (const s of loadStatuses(logDir)) {
    if (!s.paused || s.pausedBy !== FREEZE_CAUSE) continue;
    try {
      if (setWorkerPaused(logDir, s.id, false, "thaw", undefined, now)) out.push(s.id);
    } catch {
      /* ended meanwhile */
    }
  }
  return out;
}
