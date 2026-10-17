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
 *   sleeping — state running, one Bash command sleeping N >= 60s with nothing
 *              to wait on — under the stall threshold for runs like
 *              `sleep 500` (8.3m), which would otherwise be invisible until
 *              they cross it. The bounded-wait pattern (background a build or
 *              test, then `sleep 60; ps` cycles) has live children and stays
 *              quiet; stalled and thrashing remain the backstop for a child
 *              that never finishes or dies silently
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

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { alive, isChatPane, loadStatuses, nowStamp, type WorkerStatus } from "./status.js";
import { readWorkersSection } from "./config.js";
import { itermForClaudeSession, itermUuid } from "./scope.js";
// Static on purpose: a lazy import() of a dist chunk first hit after a rebuild
// throws "Cannot find module" in a long-running daemon (prune-dist.mjs deletes superseded chunks).
import {
  detectRunningWorkerErrors,
  benignNote,
  detectToolErrors,
  readToolErrors,
  SAME_WORKER_WINDOW_MS,
  toolErrorSigTag,
  toolErrorText,
} from "./tool-errors.js";
import { callAiBroker, sendToSession } from "../cli/lib/aibroker-client.js";
import { checkLoops, type LoopDeps } from "./loop-watch.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SupervisionKind = "finished" | "failed" | "stalled" | "thrashing" | "sleeping" | "toolerror" | "looping";

/** The kinds that fire mid-run and re-arm on turn progress (see eventId). */
const MID_RUN_KINDS: readonly SupervisionKind[] = ["stalled", "thrashing", "sleeping", "toolerror", "looping"];

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

/**
 * Live child pids of a runner via `pgrep -P` (its exit 1 means "no
 * children"). Any failure — here or in an injected stub — is caught at the
 * one call site in detectSupervisionEvents and reads as an empty list, so a
 * broken check degrades to firing the sleeping event, never to silencing it.
 */
function pgrepChildren(pid: number): number[] {
  return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    .split("\n")
    .flatMap((l) => {
      const n = Number(l.trim());
      return Number.isInteger(n) && n > 0 ? [n] : [];
    });
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
   * Live child pids of a runner — a sleeping worker with children is a
   * bounded wait on real work, not a stuck one. Injected so tests need no
   * pgrep; the default is pgrepChildren.
   */
  childPids?: (pid: number) => number[];
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
  if (kind === "looping") return `worker ${s.id} ${s.label} looping: ?x identical failing ? call ${tail}`;
  const why = rc === null ? "runner gone" : `rc=${rc}`;
  return `worker ${s.id} ${s.label} failed ${why} ${tail}`;
}

/**
 * Detect conditions across a ledger snapshot. Pure: statuses in, events out;
 * dedup against delivered ids is the caller's job (see filterUndelivered).
 * Workers without an owning session are skipped — nobody to notify.
 */
/** A dead, zero-turn registration older than this never ran: no alerts for it. */
export const HOLLOW_MS = 10 * 60_000;

/** Undelivered alerts older than this are history, not news. */
export const BACKLOG_AGE_MS = 3_600_000;
/** This many stale alerts collapse into one summary notice. */
export const BACKLOG_MIN = 10;

export function detectSupervisionEvents(
  statuses: WorkerStatus[],
  opts: DetectOptions
): SupervisionEvent[] {
  const isAlive = opts.isAlive ?? alive;
  const deadGraceMs = opts.deadGraceMs ?? 15_000;
  const out: SupervisionEvent[] = [];
  const present = new Set(statuses.map((s) => s.id));
  for (const s of statuses) {
    const session = ownershipKey(s);
    if (!session) continue;
    // the operator's own pane: ending it is not a worker outcome, idling is
    // not a stall — nothing here is worth a push into anybody's terminal
    if (isChatPane(s)) continue;
    // a child of another worker reports to that parent (handoff), never to
    // the operator's session
    if (s.parent && present.has(s.parent)) continue;
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
    } else if (!isAlive(s.pid) && (s.turns ?? 0) === 0 && ageMs(s.updated, opts.now) > HOLLOW_MS) {
      // hollow registration: never ran a turn and its runner is long gone —
      // there is no run to report on, so nothing to alert about
      continue;
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
      // bounded wait on real work: a sleep while a spawned child still runs
      // is healthy, so flag only a sleep with nothing to wait on. The check
      // runs once per sleeping candidate, only for a live pid; a failed
      // check reads as no children and fires. stalled (no turns) and
      // thrashing stay the backstop and never pass through here.
      let hasChildren = false;
      if (isAlive(s.pid)) {
        try {
          hasChildren = (opts.childPids ?? pgrepChildren)(s.pid).length > 0;
        } catch {
          hasChildren = false; // pgrep gone: degrade to today's behavior
        }
      }
      if (!hasChildren) kind = "sleeping";
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
  /** tool-error signature → epoch ms of its last message (one per signature per 30 min). */
  toolErrorSent?: Record<string, number>;
  /**
   * Running-worker tool-error pushes (first occurrence of each signature per
   * run, all classes): worker id → signature → push time. A pushed signature
   * is never re-pushed in that run; the map is pruned with the worker.
   */
  runningErrorSent?: Record<string, Record<string, number>>;
  /** event id → time its pointer was typed into the spawner's pane (dedup). */
  pointered?: Record<string, number>;
  /** worker id → dedup key of the last repeat-loop finding handled (see loop-watch.ts). */
  loopSent?: Record<string, string>;
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
  return { ...state, delivered: Object.fromEntries([...keptAbsent, ...keptPresent]) };
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
  const raw =
    target.iterm ?? (target.claudeSession ? itermForClaudeSession(logDir, target.claudeSession) : null);
  const iterm = raw ? bareItermUuid(raw) : null;
  if (!iterm) {
    logSkip(logDir, ev.session, ev, raw ? `target  is not an iTerm2 session UUID` : "no pane resolved for the owning session");
    return false;
  }
  try {
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

/**
 * Atomic once-only claim of an event id: O_EXCL create of a marker file, so
 * overlapping ticks (a slow push outlasting the 30 s interval) or several
 * processes cannot both deliver the same event — the state.json load/save
 * alone is a read-modify-write race.
 */
function claimEvent(logDir: string, ev: SupervisionEvent): boolean {
  const dir = join(supervisionDirPath(logDir), "claimed");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, ev.id.replace(/[^\w.@#-]/g, "_")), ev.ts, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function appendEventFile(logDir: string, ev: SupervisionEvent): void {
  const path = supervisionEventsPath(logDir, ev.session);
  const dir = supervisionDirPath(logDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(ev) + "\n", "utf8");
}

/** Record that an event reached its owner's terminal — the hook then skips it. */
function appendPushReceipt(logDir: string, ev: SupervisionEvent, key: string = ev.session): void {
  try {
    appendFileSync(supervisionPushedPath(logDir, key), `${ev.id}\n`, "utf8");
  } catch (e) {
    // a missing receipt only means the hook may repeat the line, but the cause must be findable
    logSkip(logDir, key, ev, `receipt write failed: ${(e as Error).message}`);
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
  /** Injectable typing/guard/supervisor-state for the undrained-pointer pass. */
  pointer?: Parameters<typeof pointUndrained>[4];
  /** Injectable for tests. */
  loops?: LoopDeps;
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

  // Systematic tool errors, two routes. While a worker is RUNNING and its
  // spawner is resolvable, every signature's first occurrence goes to that
  // session, all classes — actionability is not the daemon's to guess
  // (2026-10-17: a run doomed from its first tool call pushed nothing because
  // every error was [model]-class, and the spawner only found out by polling
  // `pai worker errors`). Everything else keeps the legacy actionable-only
  // route: the same signature repeating past the thresholds, once per 30 min.
  // A worker with a resolvable spawner never takes the legacy route — not
  // while running (the per-signature push already covered it), and not after
  // the run ends (the result report carries the counts).
  const sent = (state.toolErrorSent ??= {});
  for (const [sig, t] of Object.entries(sent)) if (now.getTime() - t > 86_400_000) delete sent[sig];
  const runningSent = (state.runningErrorSent ??= {});
  for (const w of Object.keys(runningSent)) if (!statuses.some((s) => s.id === w)) delete runningSent[w];
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const records = readToolErrors(logDir, now.getTime() - SAME_WORKER_WINDOW_MS);
  const ownedIds = new Set(statuses.filter((s) => ownershipKey(s)).map((s) => s.id));
  for (const p of detectRunningWorkerErrors(
    statuses
      .filter((s) => s.state === "running" && ownershipKey(s))
      .map((s) => ({ id: s.id, session: ownershipKey(s)! })),
    records,
    runningSent,
    now.getTime()
  )) {
    const owner = byId.get(p.worker);
    if (!owner) continue;
    pending.push({
      id: `${owner.id}#toolerror@${toolErrorSigTag(p.signature)}`,
      ts: nowStamp(now),
      kind: "toolerror",
      worker: owner.id,
      label: owner.label,
      session: p.session,
      rc: null,
      stalledMin: null,
      text: toolErrorText(p.group) + benignNote(p.benign),
    });
  }
  for (const g of detectToolErrors(records.filter((r) => !ownedIds.has(r.worker)), now.getTime(), sent)) {
    const owner = [...g.workers].reverse().map((w) => byId.get(w)).find((s) => s && ownershipKey(s));
    if (!owner) continue;
    pending.push({
      id: `${owner.id}#toolerror@${now.getTime()}`,
      ts: nowStamp(now),
      kind: "toolerror",
      worker: owner.id,
      label: owner.label,
      session: ownershipKey(owner)!,
      rc: null,
      stalledMin: null,
      text: toolErrorText(g),
    });
  }

  const loopSent = (state.loopSent ??= {});
  for (const w of Object.keys(loopSent)) if (!statuses.some((s) => s.id === w)) delete loopSent[w];
  for (const f of await checkLoops(logDir, statuses.filter((s) => ownershipKey(s)), loopSent, opts.loops ?? {})) {
    const owner = byId.get(f.worker);
    if (!owner) continue;
    pending.push({
      id: `${owner.id}#looping@${f.action}`,
      ts: nowStamp(now),
      kind: "looping",
      worker: owner.id,
      label: owner.label,
      session: ownershipKey(owner)!,
      rc: null,
      stalledMin: null,
      text:
        `worker ${owner.id} ${owner.label} looping: ${f.loop.count}x identical failing ${f.loop.name} call` +
        (f.action === "stop" ? " - run stopped, diff kept" : f.local ? " - correction injected" : "") +
        ` - see pai worker replay ${owner.id}`,
    });
  }

  const written: SupervisionEvent[] = [];
  for (const ev of pending) {
    if (!claimEvent(logDir, ev)) continue; // another tick/process owns this event
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
      claudeSession: ev.session || owner?.spawnerSession || null,
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
  await pointUndrained(logDir, state, statuses, now, opts.pointer);
  saveSupervisionState(statePath, pruneState(state, statuses));
  return { events: written, pushed };
}

// ---------------------------------------------------------------------------
// Pointer escalation — an alert must not wait for the next user turn
// ---------------------------------------------------------------------------

/** An alert undrained this long gets its one-line pointer typed into the pane. */
export const POINTER_AFTER_MS = 60_000;

/** Types one line into a pane; false means it did not land (retry next check). */
export type TypeFn = (iterm: string, line: string) => Promise<boolean>;

/** Whether the pane's input line holds no unsent text. Unknown counts as occupied. */
export type InputFreeFn = (iterm: string) => Promise<boolean>;

export const aibrokerType: TypeFn = async (iterm, line) => {
  const r = await sendToSession(iterm, line);
  return r.ok || r.timedOut === true;
};

/** Live pane scrollback: the input box is the last `❯` line; empty after it means free. */
export const aibrokerInputFree: InputFreeFn = async (iterm) => {
  try {
    // an unscoped reply (all sessions, or a different one) is never read as this pane's
    const res = (await callAiBroker("session_content", { sessionId: iterm, target: iterm, lines: 15 })) as {
      session?: { sessionId?: string; content?: string };
      sessions?: Array<{ sessionId?: string; content?: string }>;
      sessionId?: string;
      content?: string;
    };
    const mine =
      res.sessions?.find((x) => x.sessionId === iterm) ??
      (res.session?.sessionId === iterm ? res.session : undefined) ??
      (res.sessionId === iterm ? res : undefined);
    const content = mine?.content;
    if (typeof content !== "string") return false;
    const prompts = content.split("\n").filter((l) => /^\s*[❯>](\s|$)/.test(l));
    if (prompts.length === 0) return false;
    return prompts[prompts.length - 1].replace(/^\s*[❯>]/, "").trim() === "";
  } catch {
    return false;
  }
};

/**
 * The one pane an alert of `session` may reach: the worker's own recorded pane
 * when the worker belongs to that session, else the pane the session map ties
 * to that very session. Never a pane of any other session; null when unknown.
 */
export function paneForSession(logDir: string, session: string, owner?: WorkerStatus): string | null {
  if (owner && ownershipKey(owner) === session && owner.session?.id) return owner.session.id;
  if (owner?.spawnerSession && owner.spawnerSession !== session) return null; // event file and status disagree
  return itermForClaudeSession(logDir, session);
}

const ITERM_UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * The bare iTerm2 session UUID of a pane id ("w5t0p0:UUID" loses its prefix), or
 * null when what remains is not a UUID. AIBroker send_to_session also takes an
 * index or a name substring, which can match several sessions — never hand it one.
 */
export function bareItermUuid(term: string): string | null {
  const id = itermUuid(term);
  return ITERM_UUID_RE.test(id) ? id : null;
}

/** Record that an alert was not delivered because its target could not be resolved. */
function logSkip(logDir: string, session: string, ev: SupervisionEvent, why: string): void {
  try {
    appendFileSync(
      join(supervisionDirPath(logDir), "skipped.log"),
      `${new Date().toISOString()} session=${session} event=${ev.id} ${why}\n`,
      "utf8"
    );
  } catch {
    // the log is a courtesy
  }
}

function pointerText(n: number): string {
  return `${n} worker alert${n === 1 ? "" : "s"} pending — see WORKER EVENTS (supervision)`;
}

/**
 * Type the pointer for every alert still undrained after POINTER_AFTER_MS.
 * Undrained = beyond the session's hook cursor and not already typed in full
 * (push receipt). One pointer per session per pass, covering all its due
 * alerts; each alert is pointered once (state.pointered), so a queued pointer
 * is never re-typed. Paused/finished supervisors and occupied input lines
 * type nothing and retry on the next check.
 */
let pointerRunning = false;

/** workers.supervision.pointer; any config trouble counts as off. */
function pointerEnabled(): boolean {
  try {
    return readWorkersSection().workers.supervision.pointer === true;
  } catch {
    return false;
  }
}

export async function pointUndrained(
  logDir: string,
  state: SupervisionState,
  statuses: WorkerStatus[],
  now: Date,
  deps: { type?: TypeFn; inputFree?: InputFreeFn; enabled?: boolean } = {}
): Promise<string[]> {
  if (!(deps.enabled ?? pointerEnabled())) return [];
  // ticks can overlap (a slow type/inputFree outlives the interval); a second pass would
  // read the same undrained events before the first wrote its receipts and announce twice
  if (pointerRunning) return [];
  pointerRunning = true;
  try {
    return await pointPass(logDir, state, statuses, now, deps);
  } finally {
    pointerRunning = false;
  }
}

async function pointPass(
  logDir: string,
  state: SupervisionState,
  statuses: WorkerStatus[],
  now: Date,
  deps: { type?: TypeFn; inputFree?: InputFreeFn }
): Promise<string[]> {
  const type = deps.type ?? aibrokerType;
  const inputFree = deps.inputFree ?? aibrokerInputFree;
  const pointered = (state.pointered ??= {});
  const dir = supervisionDirPath(logDir);
  if (!existsSync(dir)) return [];
  const sessions = readdirSync(dir)
    .filter((f) => f.endsWith(".events"))
    .map((f) => f.slice(0, -".events".length));
  const typed: string[] = [];
  const typedPanes = new Set<string>(); // one notice per pane per pass, however many sessions map to it
  for (const session of sessions) {
    let lines: string[];
    try {
      lines = readFileSync(supervisionEventsPath(logDir, session), "utf8").split("\n").filter((l) => l.trim());
    } catch {
      continue;
    }
    let cursor = 0;
    try {
      cursor = Math.max(0, Number(readFileSync(join(dir, `${session}.cursor`), "utf8").trim()) || 0);
    } catch {
      // no cursor: nothing drained yet
    }
    let receipts = new Set<string>();
    try {
      receipts = new Set(readFileSync(supervisionPushedPath(logDir, session), "utf8").split("\n").map((l) => l.trim()));
    } catch {
      // no receipts
    }
    let due: SupervisionEvent[] = [];
    const stale: SupervisionEvent[] = [];
    for (const l of lines.slice(cursor)) {
      try {
        const ev = JSON.parse(l) as SupervisionEvent;
        if (ev.session && ev.session !== session) continue; // foreign event: never this session's
        const age = now.getTime() - new Date(ev.ts.replace(" ", "T")).getTime();
        if (receipts.has(ev.id) || pointered[ev.id]) continue;
        if (age > BACKLOG_AGE_MS) stale.push(ev);
        else if (age > POINTER_AFTER_MS) due.push(ev);
      } catch {
        // damaged line: the hook consumes it
      }
    }
    // a long gap: one summary instead of a flood, then past them for good
    let summary = false;
    if (stale.length >= BACKLOG_MIN) summary = true;
    else due = [...stale, ...due];
    if (due.length === 0 && !summary) continue;
    const first = summary ? stale[0] : due[0];
    const pane = paneForSession(logDir, session, statuses.find((s) => s.id === first.worker));
    if (!pane) {
      logSkip(logDir, session, first, "no pane resolved for the owning session");
      continue;
    }
    const iterm = bareItermUuid(pane);
    if (!iterm) {
      logSkip(logDir, session, first, `target  is not an iTerm2 session UUID`);
      continue;
    }
    if (typedPanes.has(iterm)) continue;
    try {
      if (!(await inputFree(iterm))) continue;
      const line = summary
        ? `${stale.length} older worker events skipped; \`pai worker errors\` has them` +
          (due.length ? `; ${pointerText(due.length)}` : "")
        : pointerText(due.length);
      if (!(await type(iterm, line))) continue;
    } catch {
      continue;
    }
    // announced = delivered: the receipt is permanent, unlike the 24 h pointered map,
    // so an announced event can never be counted again
    for (const ev of summary ? [...stale, ...due] : due) {
      pointered[ev.id] = now.getTime();
      appendPushReceipt(logDir, ev, session); // the key the events were read from, not ev.session
    }
    typedPanes.add(iterm);
    typed.push(session);
  }
  for (const [id, t] of Object.entries(pointered)) if (now.getTime() - t > 86_400_000) delete pointered[id];
  return typed;
}
