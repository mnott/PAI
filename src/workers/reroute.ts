/**
 * reroute.ts — move a worker to another provider: `rerouteWorker` is the one function behind the pane's
 * /now-less commands (/cloud, /local), `pai worker reroute` and the worker_reroute MCP tool, and behind the
 * supervision tick's time-bound escalation (`escalateOverdue`).
 *
 * A queued worker has not started: its waiting process is stopped and the same task starts on the target
 * provider. A running worker goes through the normal kill path (which salvages its commits onto its branch)
 * and the same task starts on the target, with a note naming the old id and the branch it continues from.
 *
 * The restart itself is the fall-through's: `rerunOn` (run/escalate.ts) starts the task on the target and links the
 * two runs (ledger, _fallThroughOf, fallThroughTo).
 *
 * Escalation policy (workers.escalate): queuedMaxMin, stallMaxMin, stallFailedCalls. A queued job is moved only
 * when the operator gave it priority (status.now); queuedMaxMin 0 = after URGENT_QUEUED_MIN. A job whose
 * provider was pinned (an explicit per-run --provider or --local; the session profile is not a pin) is never escalated, a job is escalated once,
 * and only to the fallback (`where: cloud`).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueDir } from "./capacity.js";
import { escalationPolicy } from "./config.js";
import { DEFAULT_ESCALATE } from "./escalation.js";
import { activeMsOf, frozenSince, inLineMs, ownMsOf } from "./freeze.js";
import { appendLedger } from "./ledger.js";
import { withCallerPath } from "./caller-env.js";
import { ledgerPath } from "./paths.js";
import type { RunOptions } from "./run/types.js";
import { loadStatus, loadStatuses, saveStatus, type WorkerStatus } from "./status.js";
import { readLocalOnly } from "./local-only-state.js";
import { readSchedFile, type SchedSnapshot } from "../router/scheduler.js";
import { markHandover } from "./run/follow-reroute.js";
import { escalationOff, getProfile } from "./session-profile-store.js";
import { yieldToLoop } from "./yield.js";

export type ReroutePolicy = ReturnType<typeof escalationPolicy>;

/** The effective policy: workers.escalate, read through the same loader as the rest of the escalation settings. */
export const reroutePolicy = escalationPolicy;

/** Minutes an urgent queued job waits before it moves when workers.escalate.queuedMaxMin is 0 (off). */
export const URGENT_QUEUED_MIN = 2;

const PINNED = /\((?:flag: --provider|local|--where local|--force-local)\)$/;

/** Whether the caller chose this run's provider (status.routeWhy names the source). */
export function providerPinned(s: Pick<WorkerStatus, "routeWhy">): boolean {
  return PINNED.test(s.routeWhy ?? "");
}

const stampMs = (stamp: string | undefined): number | null => {
  const t = stamp ? Date.parse(stamp.replace(" ", "T")) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * Why this job should move to the fallback provider now, or null. Pure: status in, reason out.
 * Skips a pinned provider, an already rerouted job, a paused one (a --now preemption or `pai worker pause`
 * is stopped by the engine control, never overdue), a job without a task copy to restart,
 * and any worker listed in the active freeze marker (a frozen run is stopped by the operator, never overdue).
 * Every elapsed-time threshold runs on the active clock: freeze AND paused minutes never count, so after a
 * thaw or resume the overdue spell restarts from its end.
 */
export function escalationReason(s: WorkerStatus, nowMs: number, p: ReroutePolicy = reroutePolicy(), sched: SchedSnapshot | null = null): string | null {
  return overdueReason(s, nowMs, p, sched, true);
}

/** Whether escalation is switched off for this run: its own --no-escalate, or its session's profile switch (unexpired). */
export function escalationSwitchedOff(s: Pick<WorkerStatus, "noEscalate" | "sessionKey" | "session">, nowMs: number): boolean {
  if (s.noEscalate) return true;
  for (const name of new Set([s.sessionKey, s.session?.name])) if (name && escalationOff(getProfile(name), nowMs)) return true;
  return false;
}

/** A stalled run the session switch is holding back, as the note ps/cockpit show; null when escalation is on or nothing is overdue. */
export function escalationHeldNote(s: WorkerStatus, nowMs: number, p: ReroutePolicy = reroutePolicy(), sched: SchedSnapshot | null = null): string | null {
  if (s.noEscalate || !escalationSwitchedOff(s, nowMs)) return null;
  const r = overdueReason(s, nowMs, p, sched, false);
  const m = r?.match(/for (\d+)m/);
  return r ? `stalled ${m ? `${m[1]}m` : r}, escalation off for this session` : null;
}

function overdueReason(s: WorkerStatus, nowMs: number, p: ReroutePolicy, sched: SchedSnapshot | null, honourSwitch: boolean): string | null {
  if (s.rerouted || s.continuedBy || s.origin === "chat" || s.paused || providerPinned(s)) return null;
  if (s.noEscalate) return null;
  if (honourSwitch && escalationSwitchedOff(s, nowMs)) return null;
  // the loop guard killed this run from outside: the runner's own escalation path never ran (the signal exits
  // before finalise), so the daemon escalates it once to the cloud here — same rules as a no-convergence stop.
  if (s.state === "killed" && s.loopStopped) return `loop-guard stop${s.last ? `: ${s.last.slice(0, 120)}` : ""}`;
  if (frozenSince(s.id) !== undefined) return null; // frozen by the operator: no escalation verdict
  if (!s.spec && !s.promptFile) return null;
  const pause = { paused: s.paused, pausedAt: s.pausedAt, pausedMs: s.pausedMs };
  if (s.state === "queued") {
    const since = s.capacity?.sinceMs ?? stampMs(s.started);
    const min = since === null || since === undefined ? 0 : activeMsOf(s.id, since, nowMs, pause) / 60_000;
    // a queued job waits for its slot unless the operator gave priority (now: /now window, --now, `pai worker priority <id> now`)
    if (!s.now) return null;
    const limit = p.queuedMaxMin > 0 ? p.queuedMaxMin : URGENT_QUEUED_MIN;
    return min >= limit ? `queued ${Math.floor(min)}m (operator priority)` : null;
  }
  if (s.state !== "running") return null;
  if ((s.consecFails ?? 0) >= p.stallFailedCalls) return `${s.consecFails} failed tool calls in a row`;
  // Progress-based escalation (operator 2026-11-23): a decision counts model
  // turns since the last progress, not minutes — a slow machine (Low Power,
  // GPU sharing) reads as busy, not stuck. The only wall-clock limit left is
  // the outer max-minutes backstop, which speed-scale.ts stretches instead.
  const since = (s.turns ?? 0) - (s.turnsAtProgress ?? 0);
  if (since < p.stallCalls) return convergenceReason(s, nowMs, p, pause);
  const what = s.readOnly ? "no successful tool call" : s.deliverable === "findings" ? "no write or report output" : "no edit or commit";
  return `${what} for ${since} turns`;
}

/**
 * Convergence rule (local runs, write jobs): a run that is armed (convergeStartMin active minutes, or convergeBudgetFraction
 * of its max-minutes budget, whichever comes first) and made no commit and no green test/tsc run for convergeQuietMin
 * active minutes keeps editing without converging: it moves to the cloud. Cloud runs and read-only/findings jobs are exempt.
 */
function convergenceReason(s: WorkerStatus, nowMs: number, p: ReroutePolicy, pause: { paused?: boolean; pausedAt?: number; pausedMs?: number }): string | null {
  if (s.route?.local !== true || s.readOnly || s.deliverable === "findings") return null;
  const startMs = stampMs(s.started);
  if (startMs === null) return null;
  const startMin = p.convergeStartMin ?? DEFAULT_ESCALATE.convergeStartMin;
  const fraction = p.convergeBudgetFraction ?? DEFAULT_ESCALATE.convergeBudgetFraction;
  const quietMin = p.convergeQuietMin ?? DEFAULT_ESCALATE.convergeQuietMin;
  const armAt = s.maxMinutes && s.maxMinutes > 0 ? Math.min(startMin, s.maxMinutes * fraction) : startMin;
  const ran = activeMsOf(s.id, startMs, nowMs, pause) / 60_000;
  if (ran < armAt) return null;
  const lastMs = Math.max(startMs, stampMs(s.convergedAt) ?? 0);
  const quiet = activeMsOf(s.id, lastMs, nowMs, pause) / 60_000;
  return quiet >= quietMin ? `${NO_CONVERGENCE} ${Math.floor(quiet)}m without commit or green check` : null;
}

/** The escalation reason's prefix for a run that edits without converging; the counters in the ledger key on it. */
export const NO_CONVERGENCE = "no convergence:";

/** A finished fall-through still blocks another reroute of its origin this long. */
export const FALLTHROUGH_RECENT_MS = 5 * 60_000;

/** The run that already continues `origin` among these statuses: queued/running, or finished within FALLTHROUGH_RECENT_MS of `nowMs`. Null when there is none. */
function recentFallThrough(all: WorkerStatus[], origin: string, nowMs: number, cleanForever = false): string | null {
  for (const s of all) {
    if (s.fallThroughOf !== origin || s.id === origin) continue;
    if (s.state === "queued" || s.state === "running") return s.id;
    if (cleanForever && s.state === "done" && (s.rc ?? 0) === 0) return s.id; // the work was done: the origin is never escalated again
    const t = stampMs(s.updated);
    if (t !== null && nowMs - t < FALLTHROUGH_RECENT_MS) return s.id;
  }
  return null;
}

/**
 * The run that already continues `origin`, read UNCACHED from the status files (a daemon restart or a stale cached
 * view cannot hide it): queued/running, or finished within FALLTHROUGH_RECENT_MS. Null when there is none.
 */
export function liveFallThrough(logDir: string, origin: string, nowMs: number = Date.now()): string | null {
  return recentFallThrough(loadStatuses(logDir), origin, nowMs, true);
}

/**
 * End a queued origin whose fall-through finished successfully (rc 0): the work is done, the origin's place in
 * line and its slot claim are moot. It leaves the provider queue (its ticket is removed; its waiting process —
 * if any still follows the restart — ends through the existing follow path), goes terminal "killed" rc 143 with
 * `continuedBy` naming the run that did the work, and a WORKER-CONTINUED ledger line says so. The follower's
 * result (and `pai worker wait`) resolves on this terminal state; the reroute guard never reroutes it again —
 * neither the `rerouted` marker nor a fresh fall-through of it stands in the way. A failed fall-through ends
 * nothing: after its recent window the origin may be rerouted once more, as before (2026-11-17: one origin
 * rerouted four times because each successful fall-through left it queued). Returns the origin's id when it ended.
 */
export function endOriginContinued(logDir: string, originId: string, by: string, nowMs: number = Date.now()): string | null {
  const st = loadStatus(logDir, originId);
  if (!st || st.state !== "queued") return null;
  rmSync(join(queueDir(logDir, st.provider), originId), { force: true });
  delete st.capacity;
  st.continuedBy = by;
  st.state = "killed";
  st.rc = 143;
  st.last = `continued by ${by}`;
  saveStatus(logDir, st, new Date(nowMs), true);
  appendLedger(ledgerPath(logDir), "WORKER-CONTINUED", { id: originId, by });
  return originId;
}

/**
 * Supervision pass (daemon tick): a queued origin whose fall-through finished clean (done, rc 0) is ended as
 * continued — out of the provider queue, never rerouted again. A fall-through that failed leaves the origin
 * queued (its recent window blocks another reroute; after it one more reroute may run). Returns every origin ended.
 */
export function endContinuedOrigins(statuses: WorkerStatus[], logDir: string, nowMs: number = Date.now()): string[] {
  const done: string[] = [];
  // one fresh read per pass (loadStatuses): the cached view must not end an origin on stale numbers.
  const all = loadStatuses(logDir);
  const byId = new Map(all.map((s) => [s.id, s]));
  for (const s of statuses) {
    if (s.state !== "queued" || !s.fallThroughTo) continue;
    // a recent fall-through still stands (live, or finished only moments ago): its caller's follow path ends the origin itself
    if (recentFallThrough(all, s.id, nowMs)) continue;
    const ft = byId.get(s.fallThroughTo);
    if (!ft || ft.state !== "done" || (ft.rc ?? 0) !== 0) continue;
    const ended = endOriginContinued(logDir, s.id, ft.id, nowMs);
    if (ended) done.push(ended);
  }
  return done;
}

export interface RerouteTarget {
  provider: string;
  model?: string;
  description: string;
}

export interface SpawnSpec {
  /** The old run and why it moves. */
  id: string;
  why: string;
  provider: string;
  model?: string;
  specFile: string;
}

export interface RerouteDeps {
  logDir: string;
  load?: (id: string) => WorkerStatus | null;
  /** "cloud" | "local" | a provider name -> the provider to start on (default: resolveTarget, the one resolver). */
  resolve?: (where: string) => Promise<RerouteTarget>;
  /** Stop the old worker the way `pai worker kill` does; it salvages the commits (default: killWorker). */
  kill?: (id: string, reason: string) => Promise<unknown>;
  /**
   * Start the task on the target provider (default: defaultSpawn, a detached `pai worker run`). It resolves once
   * the restart announced its id and throws when it did not start — rerouteWorker then keeps the old run where it
   * is (queued or running) and clears its marker; a reroute that cannot restart must not drop the job.
   */
  spawn?: (s: SpawnSpec) => void | RerouteResult["queuedAtTarget"] | Promise<void | RerouteResult["queuedAtTarget"]>;
  /** Wait before the kill so the old pane can print its line (default 1500 when the worker has a pane, tests pass 0). */
  announceMs?: number;
  /** A running job keeps running until its continuation holds a slot on the target (move to a slot-limited provider); finishDeferredMoves stops it then. A queued job is not deferred. */
  deferKill?: boolean;
  /** Who asked, for the ledger and the kill reason. */
  by?: string;
  /** Why (escalation reason); absent for an operator's command. */
  reason?: string;
}

export interface RerouteResult {
  id: string;
  provider: string;
  was: "queued" | "running" | "review" | "killed";
  branch?: string;
  specFile: string;
  description: string;
  /** The continuation waits at the target's cap instead of running (the local provider is full): never lost, it goes when a slot frees. */
  queuedAtTarget?: { position: number; queued: number };
}

/** "moved to <provider>, waiting at position N of M" — shown when the continuation queued at a full target. */
export const rerouteMessage = (r: RerouteResult): string =>
  r.queuedAtTarget ? `${r.id}: moved to ${r.provider}, waiting at position ${r.queuedAtTarget.position} of ${r.queuedAtTarget.queued}` : `${r.id}: ${r.was} -> started again on ${r.provider}${r.branch ? ` (continues branch ${r.branch})` : ""}`;

/** The note a continued task starts with. */
export const continuedNote = (id: string, branch: string): string => `continued from ${id} on branch ${branch} — its commits are there, start from that branch. If the work is already done on it, change nothing and report \"nothing to do\" as a success (r=+), never a failure`;

async function defaultResolve(where: string): Promise<RerouteTarget> {
  const { resolveTarget } = await import("./target.js");
  const t = await resolveTarget({ where });
  if (!t.provider) throw new Error(`no provider for "${where}"`);
  return { provider: t.provider, model: t.model, description: t.description };
}

async function defaultKill(logDir: string, id: string, reason: string, by: string): Promise<unknown> {
  const { killWorker } = await import("./kill-tree.js");
  const r = await killWorker(logDir, id, { by, reason });
  // a kill that returned without ending the run (pid gone but status still live, signal lost) is a failed stop
  const st = loadStatus(logDir, id);
  if (st && (st.state === "running" || st.state === "queued")) throw new Error(`worker ${id} is still ${st.state} after the stop`);
  return r;
}

/** Env the restart process carries: the old run's id and why it moved (read back by `rerunFromEnv`). */
export const RERUN_OF_ENV = "PAI_RERUN_OF";
export const RERUN_WHY_ENV = "PAI_RERUN_WHY";
/** Env carrying the terminal a daemon-side start anchors its pane to (a deep-freeze resume: the old run's `term`); read as `_hostTerm`. */
export const HOST_TERM_ENV = "PAI_HOST_TERM";
/** Env naming a file whose content is the old run's id, for a starter that cannot take custom env (`pai worker run --detach`). */
export const RERUN_OF_FILE_ENV = "PAI_RERUN_OF_FILE";

/** The old run's id from the file named in the env (a `--detach` starter carries it this way); no-op without it. */
export function rerunOfFromFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const f = env[RERUN_OF_FILE_ENV];
  if (!f) return undefined;
  try {
    return readFileSync(f, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start `bin args` in its own session with output to `outPath`; it survives its parent. The daemon calls
 * rerouteWorker, and a child in the daemon's process group dies with the job on `daemon restart` (launchd
 * tears the group down), so the restart is never an in-process run or a same-group child.
 */
export function spawnSession(bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }): number {
  const fd = openSync(o.outPath, "a");
  const child = spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  closeSync(fd);
  return child.pid ?? 0;
}

/** Env naming a file the `pai worker run|resume` process writes its worker (or chain) id to the moment it exists and its status is recorded — a gated run announces before waiting for a slot, so a queued run answers `--detach` too. */
export const ID_FILE_ENV = "PAI_WORKER_ID_FILE";

/** Called by the CLI run/resume verbs: record the id for the detached starter (no-op without the env). The run verb calls it once per id (gateStart fires at the queue, foldRun/tryPoolRun at the start). */
export function announceId(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const f = env[ID_FILE_ENV];
  if (f) writeFileSync(f, id);
}

/** Env naming a file `rerunFromEnv` writes the new run's id to at once: defaultSpawn waits on it before the old run is stopped. */
export const RERUN_ID_FILE_ENV = "PAI_RERUN_ID_FILE";

/**
 * Called by the CLI run verb for a restart (no-op without the env): record this run's id for the waiting reroute.
 * A restart announces at the queue too (gateStart): one parked at the target's cap reports its id and its queued
 * state at once, the reroute records the continuation and defaultSpawn returns the position.
 */
export function announceRerunId(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const f = env[RERUN_ID_FILE_ENV];
  if (f) writeFileSync(f, id);
}

/**
 * Wait until the restarted process announced its worker id; null when it died first or never announced. The caller
 * decides what a failed restart means — a reroute must not drop its job over one (see rerouteWorker).
 */
export async function waitAnnouncedId(idFile: string, pid: number, timeoutMs = 15_000): Promise<string | null> {
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : "";
    if (id) return id;
    if (!alive()) return null;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A restart that did not announce in time must not live on beside its origin (2026-11-18: 26042 and 43292/82237 started
 * after the 15 s wait ended, while the origin kept running). Its process group is ended; an id announced meanwhile is stopped too.
 */
export async function abandonRestart(logDir: string, idFile: string, pid: number): Promise<void> {
  try {
    if (pid > 0) process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const late = existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : "";
  if (late) await defaultKill(logDir, late, "restart abandoned: it did not announce in time", "reroute").catch(() => undefined);
}

/**
 * Start `pai worker <verb> args` detached (own session, survives a daemon restart) and return the worker id
 * once the process has announced it. The caller's env (session identity, urgency window, pane anchoring) is
 * inherited. Throws with the process output when it exits or times out before an id exists.
 */
export async function startDetachedWorker(
  logDir: string,
  args: string[],
  o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; start?: typeof spawnSession } = {}
): Promise<string> {
  const runs = join(logDir, "runs");
  mkdirSync(runs, { recursive: true });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const idFile = join(runs, `start-${tag}.id`);
  const outPath = join(runs, `start-${tag}.out`);
  const pid = (o.start ?? spawnSession)(process.env.PAI_BIN || "pai", ["worker", ...args], {
    cwd: o.cwd || process.cwd(),
    env: { ...withCallerPath(o.env ?? process.env), [ID_FILE_ENV]: idFile },
    outPath,
  });
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  for (;;) {
    const id = existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : "";
    if (id) return id;
    const out = (): string => (existsSync(outPath) ? readFileSync(outPath, "utf8").trim().split("\n").slice(-5).join("\n") : "");
    if (!alive()) throw new Error(out() || "worker failed to start");
    if (Date.now() > deadline) throw new Error(`worker did not start within ${Math.round((o.timeoutMs ?? 15_000) / 1000)}s${out() ? `: ${out()}` : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The restart is a detached `pai worker run` on the target, linked to the old run through the env (`rerunFromEnv`).
 * It returns once the new process announced its worker id; it throws when that process dies or never announces —
 * rerouteWorker then leaves the old run alone (a failed restart must not drop the job).
 */
export function defaultSpawn(logDir: string, start: typeof spawnSession = spawnSession, o: { attempts?: number; retryMs?: number; announceMs?: number } = {}): (s: SpawnSpec) => Promise<RerouteResult["queuedAtTarget"] | void> {
  return async (s) => {
    const st = loadStatus(logDir, s.id);
    if (!st) throw new Error(`no worker named "${s.id}" to restart`);
    const args = ["worker", "run", "--provider", s.provider, ...(st.outputFormat && st.outputFormat !== "text" ? ["--output-format", st.outputFormat] : []), ...(s.model ? ["--model", s.model] : []), "--label", `${st.label} (rerouted)`, "--spec", s.specFile, ...(st.className ? ["--class", st.className] : []), ...(st.topic ? ["--topic", st.topic] : []), ...(st.cwd ? ["--cwd", st.cwd] : [])];
    mkdirSync(join(logDir, "runs"), { recursive: true });
    const idFile = join(logDir, "runs", `rerun-${s.id}.id`);
    try {
      rmSync(idFile, { force: true });
    } catch {
      /* a stale file is overwritten by the new run */
    }
    // the old id as a file too: a starter that cannot take custom env (--detach) reads it (rerunOfFromFile)
    try {
      writeFileSync(join(logDir, "runs", `rerun-${s.id}.of`), s.id);
    } catch {
      /* without the file a detached reroute start still runs; its pane falls back to any live iTerm session */
    }
    // A start that dies or stays silent is tried once more after a few seconds (2026-11-23: #21, the first start was
    // abandoned at the announce timeout with an empty log and the job went ORPHANED). Each attempt logs stdout+stderr
    // to its own file next to the job's files; the failure message quotes the last lines of every attempt.
    const attempts = Math.max(1, o.attempts ?? 2);
    const failures: string[] = [];
    let newId: string | null = null;
    for (let n = 1; n <= attempts && !newId; n++) {
      const outPath = join(logDir, "runs", n === 1 ? `reroute-${s.id}.out` : `reroute-${s.id}.${n}.out`);
      try {
        rmSync(idFile, { force: true });
        rmSync(outPath, { force: true });
      } catch {
        /* stale files are overwritten */
      }
      let pid = 0;
      let spawnErr = "";
      try {
        pid = start(process.env.PAI_BIN || "pai", args, {
          cwd: st.cwd || process.cwd(),
          env: { ...withCallerPath(process.env, st.callerPath), ...(st.origin === "harness" ? { PAI_HARNESS_RUN: "1" } : {}), [RERUN_OF_ENV]: s.id, [RERUN_WHY_ENV]: s.why, [RERUN_ID_FILE_ENV]: idFile, [RERUN_OF_FILE_ENV]: join(logDir, "runs", `rerun-${s.id}.of`), [ID_FILE_ENV]: idFile },
          outPath,
        });
      } catch (e) {
        spawnErr = `spawn error: ${(e as Error).message}`;
      }
      newId = spawnErr ? null : await waitAnnouncedId(idFile, pid, o.announceMs ?? 60_000);
      if (newId) break;
      await abandonRestart(logDir, idFile, pid);
      // judged by the announced id and the process, never by the output text: the start's own stdout can carry
      // unrelated lines (a worktree gc pass) that are not a failure (2026-11-18: gc output read as "did not start").
      const tail = spawnErr || (existsSync(outPath) ? readFileSync(outPath, "utf8").trim().split("\n").slice(-5).join(" / ") : "");
      failures.push(`attempt ${n}: ${tail || "no output"} [log ${outPath}]`);
      if (n < attempts) await new Promise((r) => setTimeout(r, o.retryMs ?? 5_000));
    }
    if (!newId) throw new Error(`the restart on ${s.provider} did not start (${failures.join("; ")})`);
    // the target may be full: an announced id whose status says queued is a success — the continuation waits
    // there (never lost) and runs when a slot frees. The caller reports the position.
    const ns = loadStatus(logDir, newId);
    if (ns?.state === "queued") {
      const cap = ns.capacity;
      return { position: cap?.position ?? 1, queued: cap?.queued ?? cap?.total ?? 1 };
    }
  };
}

/**
 * Make `run` the continuation of the run named in the env (ledger, fall-through links); no-op without it.
 * The old id arrives in PAI_RERUN_OF (a reroute's own spawn) or in the file named by PAI_RERUN_OF_FILE
 * (a `--detach` starter, which cannot carry custom env).
 */
export function rerunFromEnv(run: RunOptions, logDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const of = env[RERUN_OF_ENV] || rerunOfFromFile(env);
  if (!of) return;
  delete env[RERUN_OF_ENV]; // the run's own children must not read it as theirs
  const why = env[RERUN_WHY_ENV] ?? "rerouted";
  const old = loadStatus(logDir, of);
  appendLedger(ledgerPath(logDir), "WORKER-FALLTHROUGH", { id: of, reason: why, to: run.providerFlag });
  run._route = { policy: "auto", reason: `rerouted (${why})`, local: false };
  run._fallThroughOf = of;
  run._priorIds = [of];
  run._restartOf = of; // a daemon-side start has no terminal of its own: the pane anchors to the old run's
  if (old?.term) run._hostTerm = old.term;
  run.onWorkerStart = (id2) => {
    announceRerunId(id2, env); // the waiting reroute holds the old run until this line ran
    const cur = loadStatus(logDir, of) ?? old; // fresh: the stopped origin may have rewritten its status since
    if (!cur) return;
    cur.fallThroughTo = id2;
    saveStatus(logDir, cur, new Date(), true);
  };
}

/** Where the task text of `s` lives: its --spec file or the copy the run kept. */
export function taskText(logDir: string, s: WorkerStatus): string {
  const file = [s.promptFile, s.spec, join(logDir, `${s.id}.prompt`)].find((f): f is string => !!f && f !== "-" && existsSync(f));
  if (!file) throw new Error(`worker ${s.id} kept no copy of its task (started before reroute support, or from stdin) — nothing to start elsewhere`);
  return readFileSync(file, "utf8");
}

/**
 * The whole stored task of `s`: the original spec of the root of its resume chain, then each later hop's
 * own prompt (a resume note) in order. A resumed run's promptFile holds only its note, so the last hop alone is not the task.
 */
export function fullTaskText(logDir: string, s: WorkerStatus): string {
  const chain: WorkerStatus[] = [s];
  const seen = new Set([s.id]);
  for (let cur: WorkerStatus | null = s; cur.resumedFrom && !seen.has(cur.resumedFrom); ) {
    const prev: WorkerStatus | null = loadStatus(logDir, cur.resumedFrom);
    if (!prev) break;
    seen.add(prev.id);
    chain.unshift(prev);
    cur = prev;
  }
  const texts: string[] = [];
  for (const [i, c] of chain.entries()) {
    let t = "";
    try {
      t = taskText(logDir, c).trim();
    } catch {
      continue;
    }
    if (t && !texts.includes(t)) texts.push(i === 0 ? t : `--- note from ${c.id} ---\n${t}`);
  }
  if (!texts.length) throw new Error(`worker ${s.id} kept no copy of its task`);
  return texts.join("\n\n");
}

/**
 * Move worker `id` to `where` (cloud, local or a provider name). Throws when it is not queued or running,
 * already runs there, or its task is not recoverable; nothing is stopped before those checks pass.
 */
export async function rerouteWorker(id: string, where: string, d: RerouteDeps): Promise<RerouteResult> {
  const load = d.load ?? ((x: string) => loadStatus(d.logDir, x));
  const old = load(id);
  if (!old) throw new Error(`no worker named "${id}"`);
  // a terminal run restarts only as an automatic escalation of a loop-guard stop (the guard killed it from
  // outside, so the runner's own escalation path never ran); every other terminal state is history, not a job.
  const loopStoppedRestart = old.state === "killed" && old.loopStopped === true;
  if (old.state !== "queued" && old.state !== "running" && old.state !== "review" && !loopStoppedRestart) throw new Error(`worker ${id} is ${old.state}; only a queued, running or review-stopped worker can be rerouted`);
  // the local-only window blocks automatic cloud moves (escalations, pane commands); an operator's own
  // reroute — the CLI, the cockpit — always passes (local-only.ts).
  {
    const why = await (await import("./local-only.js")).localOnlyRerouteCheck(where, { logDir: d.logDir, by: d.by });
    if (why) throw new Error(why);
  }
  const target = await (d.resolve ?? defaultResolve)(where);
  // a loop-guard stop of a run that was ALREADY on the fallback provider is not an escalation: there is no tier above
  if (loopStoppedRestart && target.provider === old.provider) throw new Error(`worker ${id} already runs on ${old.provider}: nothing to escalate to`);
  if (target.provider === old.provider) throw new Error(`worker ${id} already runs on ${old.provider}`);
  const text = taskText(d.logDir, old);
  if (d.reason) {
    // an automatic reroute: one per origin. The marker and the fall-through are read uncached (the caller's list may be stale).
    const fresh = loadStatus(d.logDir, id);
    if (fresh?.rerouted) throw new Error(`reroute skipped: ${id} already rerouted (${fresh.rerouted})`);
    const cont = liveFallThrough(d.logDir, id);
    if (cont) throw new Error(`reroute skipped: ${cont} already continues ${id}`);
  }
  const by = d.by ?? "reroute";
  const reason = d.reason ?? `${by}: ${where}`;
  // the marker first: a second tick or command sees it and does not start another reroute. A queued run's own
  // process reads it to tell a hand-over from a kill (follow-reroute.ts); an injected kill that never writes the
  // status (a test fake) still hands the caller over through markHandover below.
  old.rerouted = `${target.provider}: ${d.reason ?? by}`;
  saveStatus(d.logDir, old, new Date(), true);
  const unmark = (): void => {
    const st = load(id);
    if (st && st.rerouted === old.rerouted) {
      delete st.rerouted;
      saveStatus(d.logDir, st, new Date(), true);
    }
  };
  // a killed loop-stop keeps its worktree/branch record: the continuation continues from it like a review stop
  const branch = old.state === "running" || old.state === "review" || loopStoppedRestart ? (load(id)?.branch ?? old.branch ?? undefined) : undefined;
  const specFile = join(d.logDir, `${id}.reroute.prompt`);
  const reviewWhy = old.state === "review" ? `stopped for review: ${(old.last ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}` : "";
  const loopWhy = loopStoppedRestart ? `. It was stopped by the loop guard: ${(old.last ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}` : "";
  const note = branch ? `${continuedNote(id, branch)}${reviewWhy}${loopWhy}` : "";
  writeFileSync(specFile, note ? `${note}\n\n${text}` : text, "utf8");
  const stop = async (): Promise<void> => {
    markHandover(d.logDir, id, old.rerouted ?? `rerouted to ${target.provider} (${reason})`);
    await (d.kill ?? ((x, r) => defaultKill(d.logDir, x, r, by)))(id, `rerouted to ${target.provider} (${reason})`);
  };
  const start = async (): Promise<NonNullable<RerouteResult["queuedAtTarget"]> | undefined> => (await (d.spawn ?? defaultSpawn(d.logDir))({ id, why: `rerouted by ${by}${d.reason ? `: ${d.reason}` : ""}`, provider: target.provider, model: target.model, specFile })) ?? undefined;
  if (old.state === "review" || loopStoppedRestart) {
    // a review-stopped or loop-killed run has no process: nothing to kill. The continuation starts on the target with the branch and the
    // stop reason; the old run stays as the record, marked superseded (rerouted + continuedBy), no longer awaiting review.
    let q: NonNullable<RerouteResult["queuedAtTarget"]> | undefined;
    try {
      q = await start();
    } catch (e) {
      unmark();
      appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-SKIPPED", { id, reason: `restart failed: ${(e as Error).message}`.slice(0, 200) });
      throw e;
    }
    const end = load(id) ?? old;
    end.rerouted = old.rerouted;
    delete end.needsReview;
    if (end.fallThroughTo) end.continuedBy = end.fallThroughTo;
    saveStatus(d.logDir, end, new Date(), true);
    if (q) appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-QUEUED", { id, provider: target.provider, by, position: q.position, of: q.queued });
    return { id, provider: target.provider, was: old.state as "review" | "killed", ...(branch ? { branch } : {}), specFile, description: target.description, ...(q ? { queuedAtTarget: q } : {}) };
  }
  if (d.deferKill && old.state === "running") {
    // least impact: the continuation joins the target's queue (it waits there, not running) and the old run keeps working;
    // finishDeferredMoves stops the origin once the continuation holds a slot.
    try {
      const q = await start();
      if (q) {
        appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-QUEUED", { id, provider: target.provider, by, position: q.position, of: q.queued });
        return { id, provider: target.provider, was: old.state, ...(branch ? { branch } : {}), specFile, description: target.description, queuedAtTarget: q };
      }
    } catch (e) {
      unmark();
      appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-SKIPPED", { id, reason: `restart failed: ${(e as Error).message}`.slice(0, 200) });
      throw e;
    }
    const st = load(id) ?? old;
    st.movingTo = target.provider;
    saveStatus(d.logDir, st, new Date(), true);
    appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-DEFERRED", { id, provider: target.provider, by });
    return { id, provider: target.provider, was: old.state, ...(branch ? { branch } : {}), specFile, description: target.description };
  }
  if (old.state === "running") {
    // a running origin is stopped FIRST (its commits are salvaged onto the branch): a continuation never runs beside it.
    // A stop that fails starts nothing and leaves the origin as it is.
    const wait0 = d.announceMs ?? (old.pane ? 1500 : 0);
    if (wait0 > 0) await new Promise((r) => setTimeout(r, wait0));
    try {
      await stop();
    } catch (e) {
      unmark();
      appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-SKIPPED", { id, reason: `stop failed, no continuation started: ${(e as Error).message}`.slice(0, 200) });
      throw e;
    }
    // the origin's own exit may have rewritten its status without the marker: record the hand-over on the final state
    const end = loadStatus(d.logDir, id);
    if (end && end.rerouted !== old.rerouted) {
      end.rerouted = old.rerouted;
      saveStatus(d.logDir, end, new Date(), true);
    }
    let q: NonNullable<RerouteResult["queuedAtTarget"]> | undefined;
    try {
      q = await start();
    } catch (e) {
      appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-SKIPPED", { id, reason: `restart failed after the stop: ${(e as Error).message}`.slice(0, 600) });
      // the origin is gone: its salvaged work sits on the branch and nobody continues it — the caller must report it
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { orphaned: { branch: branch ?? null } });
    }
    // the continuation queued at a full target: it waits there (never lost); the stopped origin's work stays on its branch.
    if (q) appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-QUEUED", { id, provider: target.provider, by, position: q.position, of: q.queued });
    return { id, provider: target.provider, was: old.state, ...(branch ? { branch } : {}), specFile, description: target.description, ...(q ? { queuedAtTarget: q } : {}) };
  }
  // a queued origin: the restart first — nothing is stopped before it announced its id; a restart that cannot start
  // must leave the job where it was and say so, never drop it (2026-11-16: 93019 lost this way)
  let q: NonNullable<RerouteResult["queuedAtTarget"]> | undefined;
  try {
    q = await start();
  } catch (e) {
    unmark();
    appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-SKIPPED", { id, reason: `restart failed: ${(e as Error).message}`.slice(0, 200) });
    throw e;
  }
  const wait = d.announceMs ?? (old.pane ? 1500 : 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    await stop();
  } catch (e) {
    // the restart is live and linked; a kill that failed leaves the old run visible for `pai worker kill`
    appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-SKIPPED", { id, reason: `stop failed after the restart: ${(e as Error).message}`.slice(0, 200) });
    throw e;
  }
  if (q) appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE-QUEUED", { id, provider: target.provider, by, position: q.position, of: q.queued });
  return { id, provider: target.provider, was: old.state as "queued", ...(branch ? { branch } : {}), specFile, description: target.description, ...(q ? { queuedAtTarget: q } : {}) };
}

export interface Escalation {
  id: string;
  label: string;
  provider: string;
  reason: string;
  session: string | null;
  /** The restart failed after the origin was stopped: the work is orphaned on this branch (null: no branch kept). */
  orphaned?: { branch: string | null };
}

/**
 * The supervision tick's pass: every overdue job goes to the fallback provider through rerouteWorker.
 * One escalation per job (the marker is written before anything is stopped, a failed reroute keeps it),
 * and a job already on the fallback is left alone.
 */
export async function escalateOverdue(
  statuses: WorkerStatus[],
  d: Omit<RerouteDeps, "by" | "reason">,
  nowMs: number = Date.now(),
  policy: ReroutePolicy = reroutePolicy()
): Promise<Escalation[]> {
  const done: Escalation[] = [];
  const sched = readSchedFile(d.logDir, nowMs);
  for (const s of statuses) {
    await yieldToLoop(); // one worker per slice: an IPC request waits for one item, not the pass
    // the local-only window blocks automatic cloud moves: an overdue job stays where it is until the window ends (rerouteWorker would refuse it anyway — this keeps its marker clean and the retry honest)
    if (readLocalOnly(nowMs)) continue;
    const reason = escalationReason(s, nowMs, policy, sched);
    if (!reason) {
      // a stall the session switch holds back stays visible in ps / the cockpit
      const held = s.state === "running" ? escalationHeldNote(s, nowMs, policy, sched) : null;
      if (held !== (s.escalationHeld ?? null)) {
        const st = (d.load ?? ((x: string) => loadStatus(d.logDir, x)))(s.id);
        if (st && st.state === "running") {
          if (held) st.escalationHeld = held;
          else delete st.escalationHeld;
          saveStatus(d.logDir, st, new Date(), true);
        }
      }
      continue;
    }
    try {
      const r = await rerouteWorker(s.id, "cloud", { ...d, by: "escalation", reason });
      // counted per model for the escalation measurements (#26): one ledger line per convergence escalation
      if (reason.startsWith(NO_CONVERGENCE)) appendLedger(ledgerPath(d.logDir), "WORKER-ESCALATE-NOCONVERGE", { id: s.id, model: s.model || "?", provider: s.provider, reason });
      done.push({ id: s.id, label: s.label, provider: r.provider, reason, session: s.spawnerSession ?? s.session?.id ?? null });
    } catch (e) {
      const orphaned = (e as { orphaned?: { branch: string | null } }).orphaned;
      if (orphaned) done.push({ id: s.id, label: s.label, provider: "cloud", reason: `restart failed after the stop: ${(e as Error).message}`.slice(0, 600), session: s.spawnerSession ?? s.session?.id ?? null, orphaned });
      // already on the fallback or no task copy: marked so the next tick does not try again
      const st = (d.load ?? ((x: string) => loadStatus(d.logDir, x)))(s.id);
      if (st && !st.rerouted) {
        st.rerouted = `skipped: ${(e as Error).message}`.slice(0, 120);
        saveStatus(d.logDir, st, new Date(), true);
      }
    }
  }
  return done;
}

/** The orchestrator's AG2 S message for one escalation. */
export const escalationMessage = (e: Escalation): string =>
  e.orphaned
    ? `S|i=${e.id}|z=${e.label}: ORPHANED, stopped for escalation but the continuation did not start (${e.reason}); work is on ${e.orphaned.branch ? `branch ${e.orphaned.branch}` : "no kept branch"} - restart it with pai worker run`
    : `S|i=${e.id}|z=${e.label}: escalated to ${e.provider}: ${e.reason}`;

/** The pane's one line for an escalation. */
export const escalationLine = (rerouted: string): string => `» escalated to ${rerouted}`;

/**
 * Supervision pass (daemon tick): a running job that is moving to a slot-limited provider (status.movingTo) keeps running
 * until its continuation holds a slot there; only then it is stopped the normal way. A continuation that ended without
 * running leaves the job where it was (its marker is cleared). Returns the ids stopped.
 */
export async function finishDeferredMoves(logDir: string, kill?: (id: string, reason: string) => Promise<unknown>, by = "reroute"): Promise<string[]> {
  const all = loadStatuses(logDir);
  const done: string[] = [];
  for (const s of all) {
    if (!s.movingTo || s.state !== "running") continue;
    const cont = all.find((x) => x.fallThroughOf === s.id && x.id !== s.id);
    if (cont?.state === "queued") continue;
    const fresh = loadStatus(logDir, s.id);
    if (!fresh?.movingTo) continue;
    if (cont?.state === "running") {
      markHandover(logDir, s.id, fresh.rerouted ?? `rerouted to ${s.movingTo}`);
      await (kill ?? ((x, r) => defaultKill(logDir, x, r, by)))(s.id, `rerouted to ${s.movingTo} (${by}: slot free)`);
      done.push(s.id);
    } else if (!cont || cont.state !== "done") {
      // the continuation is gone or failed: stay where we are
      delete fresh.movingTo;
      delete fresh.rerouted;
      saveStatus(logDir, fresh, new Date(), true);
    }
  }
  return done;
}
