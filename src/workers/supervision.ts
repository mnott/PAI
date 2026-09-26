/**
 * supervision.ts — daemon-side worker supervision, event push not polling.
 *
 * An orchestrating session must keep an eye on its workers without sleeping
 * (the Worker skill forbids busy-waiting), the same way the AIBroker daemon
 * keeps an eye on sessions. The PAI daemon already runs all day; this module
 * gives it a tick that watches every worker's status file and pushes one-line
 * events to the owning session when something happens:
 *
 *   finished — the run ended clean (state done, rc 0)
 *   failed   — the run ended badly (state failed/killed/lost, or rc != 0,
 *              or the runner pid vanished while state was still running)
 *   stalled  — state running, runner alive, but no new turn for longer than
 *              the stall threshold (PAI_WORKER_STALL_MINUTES, default 10)
 *   thrashing — state running, runner alive, turning, but the last N tool
 *              executions all failed (PAI_WORKER_THRASH_FAILS, default 5) —
 *              a worker that keeps failing every command never goes quiet,
 *              so the stall detector alone cannot see it
 *   sleeping — state running, one Bash command sleeping N >= 60s — under the
 *              stall threshold for runs like `sleep 500` (8.3m), which would
 *              otherwise be invisible until they cross it
 *
 * The interactive chat pane (origin "chat") is never supervised: it is the
 * operator's own session, not a task worker. Its status file flips to done
 * when the session ends, and reporting that as "worker finished" to whoever
 * next opens the same tab is noise, not an outcome.
 *
 * Delivery, in order of preference, never both counted as required:
 *   1. AIBroker `send_to_session` into the orchestrator's terminal — the
 *      one-line Agentish-style notification, arriving as a user turn without
 *      the orchestrator asking for it. Needs the iTerm identity of the owner,
 *      which the status line bridges into the session map (see scope.ts).
 *   2. An append-only event file, <logDir>/supervision/<owner>.events, one
 *      JSON line per event. The UserPromptSubmit hook
 *      (src/hooks/ts/user-prompt/worker-supervision.ts) surfaces undelivered
 *      lines into the session that owns them, so the events reach the model
 *      on its next turn even with AIBroker absent.
 *
 * Exactly-once: every event carries a deterministic id and the set of
 * delivered ids per worker is persisted (<logDir>/supervision/state.json), so
 * a daemon restart replays nothing. A first run with no state adopts every
 * already-terminal worker as delivered — supervision reports transitions it
 * observes, not history. Chain stages are separate workers with their own
 * status files and are supervised individually.
 *
 * No model is ever called from here — this is daemon code, and it must stay
 * that way: supervision that bills tokens to watch tokens is a bug.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { alive, isChatPane, loadStatuses, nowStamp, type WorkerStatus } from "./status.js";
import { itermForClaudeSession } from "./scope.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SupervisionKind = "finished" | "failed" | "stalled" | "thrashing" | "sleeping";

/** The kinds that fire mid-run and re-arm on turn progress (see eventId). */
const MID_RUN_KINDS: readonly SupervisionKind[] = ["stalled", "thrashing", "sleeping"];

export interface SupervisionEvent {
  /** Deterministic dedup key — see eventId(). */
  id: string;
  /** nowStamp() at detection. */
  ts: string;
  kind: SupervisionKind;
  worker: string;
  label: string;
  /** Owning session key: the spawner's claude session id, or the iTerm uuid. */
  session: string;
  /** Exit code when the run reported one, else null. */
  rc: number | null;
  /** Minutes without a turn, for stalled events; else null. */
  stalledMin: number | null;
  /** Consecutive failed commands, for thrashing events; else null. */
  consecFails?: number | null;
  /** Seconds of the one sleeping command, for sleeping events; else null. */
  sleepSec?: number | null;
  /** The one-liner that reaches the orchestrator. */
  text: string;
}

/**
 * The owning session of a worker, or null when nobody claims it (and so
 * nothing to notify): the spawner's claude session id first — that is what
 * the hook knows a session by — else the AIBroker iTerm uuid.
 */
export function ownershipKey(s: WorkerStatus): string | null {
  if (s.spawnerSession) return s.spawnerSession;
  if (s.session?.id) return s.session.id;
  return null;
}

const TERMINAL: readonly WorkerStatus["state"][] = ["done", "failed", "killed", "lost"];

function isTerminal(s: WorkerStatus): boolean {
  return TERMINAL.includes(s.state);
}

/** Age of a "YYYY-MM-DD HH:MM:SS" stamp in ms, NaN-safe (unparsable → 0). */
function ageMs(ts: string, now: Date): number {
  const t = Date.parse(ts.replace(" ", "T"));
  if (Number.isNaN(t)) return 0;
  return Math.max(0, now.getTime() - t);
}

/**
 * The stall threshold in minutes from PAI_WORKER_STALL_MINUTES (default 10).
 * Anything unparsible or non-positive falls back to the default — a broken
 * value must not turn supervision off or make it fire every tick.
 */
export const DEFAULT_STALL_MINUTES = 10;

export function stallMinutesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAI_WORKER_STALL_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_STALL_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_MINUTES;
}

/**
 * The consecutive-failure threshold from PAI_WORKER_THRASH_FAILS (default 5),
 * with the same broken-value tolerance as stallMinutesFromEnv.
 */
export const DEFAULT_THRASH_FAILS = 5;

export function thrashFailsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAI_WORKER_THRASH_FAILS;
  if (raw === undefined || raw === "") return DEFAULT_THRASH_FAILS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRASH_FAILS;
}

/**
 * Event id: `<worker>#<kind>` for the once-per-run terminal kinds, and
 * `<worker>#<kind>@<turns>` for the mid-run kinds (stalled, thrashing,
 * sleeping) — the turn count re-arms the id, so a worker that resumes and
 * hits the same condition again gets a second event while a restart cannot
 * replay the first.
 */
export function eventId(worker: string, kind: SupervisionKind, turns = 0): string {
  return MID_RUN_KINDS.includes(kind) ? `${worker}#${kind}@${turns}` : `${worker}#${kind}`;
}

export interface DetectOptions {
  /** How long a running worker may go without a turn before "stalled". */
  stallMs: number;
  now: Date;
  /** Consecutive failed tool executions before "thrashing" (default 5). */
  thrashFails?: number;
  /** pid liveness — injected so tests need no real processes. */
  isAlive?: (pid: number) => boolean;
  /**
   * How stale `updated` must be before a dead pid counts as killed rather
   * than as a status write racing the tick.
   */
  deadGraceMs?: number;
}

/** One event's one-liner — the exact line the orchestrator reads. */
function eventText(kind: SupervisionKind, s: WorkerStatus, rc: number | null, stalledMin: number | null): string {
  const tail = `- see pai worker replay ${s.id}`;
  if (kind === "finished") return `worker ${s.id} ${s.label} finished rc=0 ${tail}`;
  if (kind === "stalled") return `worker ${s.id} ${s.label} stalled ${stalledMin}m no turns ${tail}`;
  if (kind === "thrashing")
    return `worker ${s.id} ${s.label} thrashing: ${s.consecFails} consecutive failed commands ${tail}`;
  if (kind === "sleeping") return `worker ${s.id} ${s.label} sleeping ${s.sleepSec}s in one command ${tail}`;
  const why = rc === null ? "runner gone" : `rc=${rc}`;
  return `worker ${s.id} ${s.label} failed ${why} ${tail}`;
}

/**
 * Detect conditions across a ledger snapshot. Pure: statuses in, events out;
 * dedup against delivered ids is the caller's job (see filterUndelivered).
 * Workers without an owning session are skipped — nobody to notify.
 */
export function detectSupervisionEvents(
  statuses: WorkerStatus[],
  opts: DetectOptions
): SupervisionEvent[] {
  const isAlive = opts.isAlive ?? alive;
  const deadGraceMs = opts.deadGraceMs ?? 15_000;
  const out: SupervisionEvent[] = [];
  for (const s of statuses) {
    const session = ownershipKey(s);
    if (!session) continue;
    // the operator's own pane: ending it is not a worker outcome, idling is
    // not a stall — nothing here is worth a push into anybody's terminal
    if (isChatPane(s)) continue;
    let kind: SupervisionKind | null = null;
    let rc: number | null = null;
    let stalledMin: number | null = null;
    if (isTerminal(s)) {
      // a finished run is state done with rc 0; every other terminal shape
      // (failed, killed, lost, done with a non-zero rc) is a failure
      if (s.state === "done" && (s.rc ?? 0) === 0) {
        kind = "finished";
        rc = 0;
      } else {
        kind = "failed";
        rc = s.state === "lost" ? null : s.rc;
      }
    } else if (!isAlive(s.pid) && ageMs(s.updated, opts.now) > deadGraceMs) {
      // state says running but the runner is gone (SIGKILL, crash) — the
      // status will never get its rc, so supervision is the only witness
      kind = "failed";
      rc = null;
    } else if (ageMs(s.updated, opts.now) > opts.stallMs) {
      kind = "stalled";
      stalledMin = Math.floor(ageMs(s.updated, opts.now) / 60_000);
    } else if ((s.consecFails ?? 0) >= (opts.thrashFails ?? DEFAULT_THRASH_FAILS)) {
      kind = "thrashing";
    } else if (s.sleepSec != null) {
      kind = "sleeping";
    }
    if (!kind) continue;
    out.push({
      id: eventId(s.id, kind, s.turns),
      ts: nowStamp(opts.now),
      kind,
      worker: s.id,
      label: s.label,
      session,
      rc,
      stalledMin,
      ...(kind === "thrashing" ? { consecFails: s.consecFails ?? 0 } : {}),
      ...(kind === "sleeping" ? { sleepSec: s.sleepSec ?? 0 } : {}),
      text: eventText(kind, s, rc, stalledMin),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delivered-id persistence — the restart guard
// ---------------------------------------------------------------------------

export interface SupervisionState {
  /** worker id → event ids already written to that owner's event file. */
  delivered: Record<string, string[]>;
}

/** Cap on remembered workers: terminal and delivered is history, not state. */
const MAX_REMEMBERED_WORKERS = 500;

export function supervisionDirPath(logDir: string): string {
  return join(logDir, "supervision");
}

export function supervisionStatePath(logDir: string): string {
  return join(supervisionDirPath(logDir), "state.json");
}

export function supervisionEventsPath(logDir: string, session: string): string {
  return join(supervisionDirPath(logDir), `${session}.events`);
}

/** Receipts of events already pushed into a terminal, one event id per line. */
export function supervisionPushedPath(logDir: string, session: string): string {
  return join(supervisionDirPath(logDir), `${session}.pushed`);
}

export function loadSupervisionState(path: string): { state: SupervisionState; fresh: boolean } {
  if (!existsSync(path)) return { state: { delivered: {} }, fresh: true };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SupervisionState;
    if (parsed && typeof parsed === "object" && typeof parsed.delivered === "object") {
      return { state: parsed, fresh: false };
    }
  } catch {
    // a damaged state file replays at most one round of terminal events;
    // rewriting it is the recovery, not the problem
  }
  return { state: { delivered: {} }, fresh: true };
}

export function saveSupervisionState(path: string, state: SupervisionState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, path);
}

/**
 * Drop the delivered ids of workers the ledger no longer lists (absent means
 * history: their status files are gone) and cap only that history — newest
 * ids last, worker ids sort chronologically — so the persisted state stays
 * bounded. A worker the ledger still lists must never lose its receipts:
 * pruning one un-marks its terminal events as delivered, and every save
 * re-arms them into an unbounded re-delivery loop (the 2026-09-25 incident:
 * one old chain stage re-pushed 7,393 times, because the cap of 500 bit into
 * a ledger of ~1,700 live statuses).
 */
export function pruneState(
  state: SupervisionState,
  statuses: WorkerStatus[],
  maxAbsent = MAX_REMEMBERED_WORKERS
): SupervisionState {
  const present = new Set(statuses.map((s) => s.id));
  const entries = Object.entries(state.delivered);
  const byId = ([a]: [string, string[]], [b]: [string, string[]]) => (a < b ? -1 : a > b ? 1 : 0);
  const keptPresent = entries.filter(([id]) => present.has(id)).sort(byId);
  const absent = entries.filter(([id]) => !present.has(id)).sort(byId);
  // not slice(-maxAbsent): with maxAbsent 0 that returns the whole array
  const keptAbsent = absent.slice(Math.max(0, absent.length - maxAbsent));
  return { delivered: Object.fromEntries([...keptAbsent, ...keptPresent]) };
}

/**
 * First run: adopt every already-terminal worker as delivered. Supervision
 * reports the transitions it observes from now on, never a replay of every
 * worker that ever finished before it started.
 */
export function baselineState(statuses: WorkerStatus[]): SupervisionState {
  const delivered: Record<string, string[]> = {};
  for (const s of statuses) {
    if (!isTerminal(s) || !ownershipKey(s)) continue;
    delivered[s.id] = [eventId(s.id, "finished"), eventId(s.id, "failed")];
  }
  return { delivered };
}

/** The events whose ids the state has not seen yet. */
export function filterUndelivered(events: SupervisionEvent[], state: SupervisionState): SupervisionEvent[] {
  return events.filter((e) => !(state.delivered[e.worker] ?? []).includes(e.id));
}

export function markDelivered(state: SupervisionState, events: SupervisionEvent[]): void {
  for (const e of events) {
    const ids = state.delivered[e.worker] ?? [];
    if (!ids.includes(e.id)) ids.push(e.id);
    state.delivered[e.worker] = ids;
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Where an event's push goes, resolved from the worker's own identities. */
export interface PushTarget {
  claudeSession: string | null;
  iterm: string | null;
}

export type PushFn = (logDir: string, target: PushTarget, ev: SupervisionEvent) => Promise<boolean>;

/**
 * Default push: AIBroker `send_to_session` into the orchestrator's terminal,
 * using the iTerm uuid the worker recorded (`session.id`) or the one the
 * session map bridges for the spawner's claude session. A timeout still
 * delivered (see aibroker-client) counts as delivered; every failure is
 * reported as not-delivered so only the event file carries the event.
 */
export const aibrokerPush: PushFn = async (logDir, target, ev) => {
  const iterm =
    target.iterm ?? (target.claudeSession ? itermForClaudeSession(logDir, target.claudeSession) : null);
  if (!iterm) return false;
  try {
    const { sendToSession } = await import("../cli/lib/aibroker-client.js");
    const r = await sendToSession(iterm, ev.text);
    return r.ok || r.timedOut === true;
  } catch {
    return false;
  }
};

/**
 * Whether an event should be relayed into the owner's terminal. The mid-run
 * kinds (stalled, thrashing, sleeping) ALWAYS relay: a json/stream-json
 * caller knows the run's result at exit but has no other way to hear
 * mid-run trouble. Only the terminal kinds (finished/failed) skip the relay
 * for those callers — they read the run's result itself, and the harness
 * already notifies them on process exit, so the one-liner would cost a full
 * extra turn for information they already have. Interactive/pane launches
 * and the default text format are never skipped.
 */
export function shouldRelay(
  kind: SupervisionKind,
  outputFormat: WorkerStatus["outputFormat"] | undefined
): boolean {
  if (MID_RUN_KINDS.includes(kind)) return true;
  return outputFormat !== "json" && outputFormat !== "stream-json";
}

function appendEventFile(logDir: string, ev: SupervisionEvent): void {
  const path = supervisionEventsPath(logDir, ev.session);
  const dir = supervisionDirPath(logDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(ev) + "\n", "utf8");
}

/** Record that an event reached its owner's terminal — the hook then skips it. */
function appendPushReceipt(logDir: string, ev: SupervisionEvent): void {
  try {
    appendFileSync(supervisionPushedPath(logDir, ev.session), `${ev.id}\n`, "utf8");
  } catch {
    // a missing receipt only means the hook may repeat the line
  }
}

export interface TickOptions {
  now?: Date;
  stallMs?: number;
  /** Consecutive-failure threshold for thrashing (default: PAI_WORKER_THRASH_FAILS). */
  thrashFails?: number;
  isAlive?: (pid: number) => boolean;
  /** Injectable for tests; production pushes through AIBroker. */
  push?: PushFn;
  /** Preloaded map, so a test (or a batch of ticks) can share one read. */
  statuses?: WorkerStatus[];
}

export interface TickResult {
  events: SupervisionEvent[];
  /** Events that also reached a terminal through the push channel. */
  pushed: SupervisionEvent[];
}

/**
 * One supervision pass over the ledger: detect, append each new event to its
 * owner's event file, push it best effort, persist the delivered ids. The
 * event file is the durable record — an event is marked delivered only after
 * its line landed there, so a failed tick retries, a repeated one replays
 * nothing.
 */
export async function runSupervisionTick(logDir: string, opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const statuses = opts.statuses ?? loadStatuses(logDir);
  const statePath = supervisionStatePath(logDir);
  const loaded = loadSupervisionState(statePath);
  let state = loaded.state;
  if (loaded.fresh) state = baselineState(statuses);

  const pending = filterUndelivered(
    detectSupervisionEvents(statuses, {
      stallMs: opts.stallMs ?? DEFAULT_STALL_MINUTES * 60_000,
      thrashFails: opts.thrashFails ?? thrashFailsFromEnv(),
      now,
      ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
    }),
    state
  );

  const written: SupervisionEvent[] = [];
  for (const ev of pending) {
    appendEventFile(logDir, ev);
    written.push(ev);
  }

  const push = opts.push ?? aibrokerPush;
  const pushed: SupervisionEvent[] = [];
  for (const ev of written) {
    // the owner's iTerm identity is in its worker status, not the event
    const owner = statuses.find((s) => s.id === ev.worker);
    if (!shouldRelay(ev.kind, owner?.outputFormat)) continue; // caller reads its own JSON result
    const target: PushTarget = {
      claudeSession: owner?.spawnerSession ?? null,
      iterm: owner?.session?.id ?? null,
    };
    let ok = false;
    try {
      ok = await push(logDir, target, ev);
    } catch {
      ok = false;
    }
    if (ok) {
      pushed.push(ev);
      appendPushReceipt(logDir, ev);
    }
  }

  markDelivered(state, written);
  saveSupervisionState(statePath, pruneState(state, statuses));
  return { events: written, pushed };
}
