/**
 * preempt.ts — a `--now` run on a local provider goes first. The other local
 * workers on that provider are paused at once (reason "preempted by <id>", so
 * the router also aborts the request each has in flight and re-sends it on
 * resume), they stop counting against the provider's cap while paused, and
 * they resume exactly when the now run ends. Paused time is added to their
 * deadline (active-time.ts preemptedMsOf).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getProviderOrNative, isLocalProvider, readWorkersSection } from "./config.js";
import { providerCap, queueDir, writeTicket } from "./capacity.js";
import { readUrgencyFor } from "./urgency.js";
import { setWorkerPaused, setWorkerPriority } from "./engine-control.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { isLive, ownsPidCached, loadStatuses, loadLiveStatusesCached, loadStatus, saveStatus, slotLent, type WorkerStatus } from "./status.js";

/** Slots free on `provider`: its cap minus every live running worker that holds one — including a preempted one whose pause has ended. A released preemption goes back through the capacity gate's queue like any other run, never over the cap (a slot its victim held during the pause may already have gone to another run). Unlimited when uncapped. */
function roomOn(statuses: WorkerStatus[], provider: string): number {
  let cap: number | undefined;
  try {
    cap = providerCap(readWorkersSection().workers, provider);
  } catch {
    cap = undefined;
  }
  if (cap === undefined) return Number.MAX_SAFE_INTEGER;
  const holding = statuses.filter((s) => s.provider === provider && s.state === "running" && !slotLent(s) && isLive(s)).length;
  return cap - holding;
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
  const next = otherUrgent(all.filter((x) => isLive(x)), cur.provider, by);
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
function otherUrgent(statuses: WorkerStatus[], provider: string, except: string): WorkerStatus | undefined {
  return statuses.find((s) => s.id !== except && s.now && s.provider === provider && (s.state === "running" || s.state === "queued"));
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
    if (s.pausedBy !== by || s.state !== "running" || !loadStatus(logDir, s.id)?.paused) continue;
    try {
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
