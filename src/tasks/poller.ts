/**
 * poller.ts — one scheduler tick
 *
 * Reads Todoist, decides, acts, reports. Run by launchd on an interval; carries
 * no LLM, so a tick that finds nothing to do costs one API call and no tokens.
 *
 * Run state (start times, probe counts) is deliberately local and transient.
 * Losing it costs one extra probe, not a wrong decision — `decide` returns
 * "orphaned" rather than assuming a task is dead. The durable state — schedule,
 * order, running flag, learned durations — all lives in Todoist, so a new
 * machine picks up where this one left off.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonStrict, writeJsonAtomic } from "../config/json-store.js";
import type { TodoistProvider } from "./providers/todoist.js";
import type { Transport } from "./dispatch.js";
import { dispatchTask } from "./dispatch.js";
import {
  decide,
  dispatchOrder,
  isRunning,
  RUNNING_LABEL,
  STUCK_AFTER_FAILED_PROBES,
  type Decision,
  expectedMinutes,
  type RunState,
  EMPTY_RUN_STATE,
} from "./scheduler.js";
import type { Task } from "./types.js";

const STATE_FILE = join(homedir(), ".pai", "scheduler-state.json");

/** How many past durations to keep per task. */
const HISTORY_LIMIT = 5;

interface PersistedState extends RunState {
  /** Task id → observed durations in minutes, most recent last. */
  history: Record<string, number[]>;
  /** Task id → epoch ms of the last completion we reported. */
  lastReported: Record<string, number>;
}

const EMPTY: PersistedState = { ...EMPTY_RUN_STATE, history: {}, lastReported: {} };

/**
 * Run state is a rebuildable cache, so a damaged file must not block the
 * scheduler forever — starting fresh is the correct recovery here, which is
 * exactly the case json-store's guard is NOT for.
 */
function loadState(): PersistedState {
  try {
    const raw = readJsonStrict(STATE_FILE, "~/.pai/scheduler-state.json");
    return { ...EMPTY, ...(raw as unknown as PersistedState) };
  } catch {
    return { ...EMPTY };
  }
}

function saveState(state: PersistedState): void {
  writeJsonAtomic(STATE_FILE, state as unknown as Record<string, unknown>, { backup: false });
}

// ---------------------------------------------------------------------------
// Liveness probe
// ---------------------------------------------------------------------------

/**
 * What a probe found.
 *
 * The distinction that matters is `busy` versus `silent`. Claude Code queues
 * typed input while mid-turn and does not read it until the turn ends, so a
 * session doing exactly the work we gave it stays silent for minutes. Since we
 * probe at expected x1.5 — precisely when a slow task is most likely still
 * working — treating silence as death would have declared healthy sessions
 * stuck on ordinary days and "recovered" them out from under themselves.
 *
 * AIBroker therefore decides liveness by sampling the screen before sending
 * anything: a working session animates, an idle one is static. `busy` is
 * positive evidence of life and must never count toward the stuck threshold.
 */
export type ProbeState = "replied" | "busy" | "silent" | "absent";

export interface ProbeAnswer {
  state: ProbeState;
  reply?: string;
  reason?: string;
}

export interface Prober {
  /** Ask the owning session whether it is still working. */
  ask(project: string, question: string): Promise<ProbeAnswer>;
}

/**
 * Multiple of the expected duration past which a task is flagged even though it
 * keeps reporting `busy`. A session can be alive and still wrong — stuck in a
 * loop, waiting on a prompt that will never come. Liveness is not progress.
 */
const GROSS_OVERRUN_FACTOR = 5;

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface TickOptions {
  provider: TodoistProvider;
  transport: Transport | null;
  prober: Prober | null;
  autoDispatch: boolean;
  dryRun: boolean;
  now?: number;
}

export interface TickReport {
  decisions: Array<{ decision: Decision; note: string }>;
  dispatched: number;
  completed: number;
  stuck: number;
  probed: number;
}

export async function tick(opts: TickOptions): Promise<TickReport> {
  const now = opts.now ?? Date.now();
  const state = loadState();
  const report: TickReport = { decisions: [], dispatched: 0, completed: 0, stuck: 0, probed: 0 };

  const tasks = await opts.provider.listOpen({ includeUnrouted: true });
  const ordered = dispatchOrder(tasks);

  for (const task of ordered) {
    const d = decide(task, { now, state, history: state.history });
    let note = "";

    switch (d.action) {
      case "wait":
        continue; // not worth reporting

      case "skip":
        note = d.reason;
        break;

      case "running":
        note = `${d.elapsedMinutes}m elapsed`;
        break;

      case "dispatch":
        note = await handleDispatch(task, d.overdueMinutes, opts, state, now);
        if (!opts.dryRun) report.dispatched++;
        break;

      case "complete":
        note = await handleComplete(task, d.durationMinutes, opts, state);
        if (!opts.dryRun) report.completed++;
        break;

      case "probe":
      case "orphaned": {
        const elapsed = d.action === "probe" ? d.elapsedMinutes : null;
        const result = await handleProbe(task, elapsed, opts, state);
        note = result.note;
        if (!opts.dryRun) {
          report.probed++;
          if (result.stuck) report.stuck++;
        }
        break;
      }
    }

    report.decisions.push({ decision: d, note });
  }

  if (!opts.dryRun) saveState(state);
  return report;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleDispatch(
  task: Task,
  overdue: number,
  opts: TickOptions,
  state: PersistedState,
  now: number
): Promise<string> {
  const late = overdue > 5 ? ` (${overdue}m late)` : "";
  if (opts.dryRun) return `would dispatch to ${task.owner.project ?? "nobody"}${late}`;

  if (!task.owner.project) return "unrouted — cannot dispatch";

  const result = await dispatchTask(task, {
    transport: opts.transport,
    autoDispatch: opts.autoDispatch,
    spawnIfAbsent: true,
  });

  if (result.outcome === "delivered" || result.outcome === "spawned") {
    // Mark running FIRST so a crash between here and the next tick leaves the
    // task visibly in flight rather than being dispatched twice.
    await opts.provider.setLabels(task.id, [...task.labels, RUNNING_LABEL]);
    state.startedAt[task.id] = now;
    delete state.failedProbes[task.id];
    return `${result.outcome} to ${result.session}${late}`;
  }

  return `not dispatched: ${result.outcome}${result.reason ? " — " + result.reason : ""}`;
}

async function handleComplete(
  task: Task,
  durationMinutes: number | null,
  opts: TickOptions,
  state: PersistedState
): Promise<string> {
  if (opts.dryRun) return `would clear ${RUNNING_LABEL}, ${durationMinutes ?? "?"}m`;

  await opts.provider.setLabels(
    task.id,
    task.labels.filter((l) => l.toLowerCase() !== RUNNING_LABEL)
  );

  const wasStuck = (state.failedProbes[task.id] ?? 0) > 0;
  delete state.startedAt[task.id];
  delete state.failedProbes[task.id];

  // A run that needed probing may have been stalled for most of its wall time.
  // Feeding that into the average would inflate every later threshold.
  if (durationMinutes !== null && !wasStuck) {
    const hist = state.history[task.id] ?? [];
    hist.push(durationMinutes);
    state.history[task.id] = hist.slice(-HISTORY_LIMIT);
  }

  return durationMinutes === null
    ? "completed (duration unknown)"
    : `completed in ${durationMinutes}m${wasStuck ? " — not recorded, run was probed" : ""}`;
}

async function handleProbe(
  task: Task,
  elapsed: number | null,
  opts: TickOptions,
  state: PersistedState
): Promise<{ note: string; stuck: boolean }> {
  const project = task.owner.project;
  const el = elapsed === null ? "unknown" : `${elapsed}m`;

  if (opts.dryRun) return { note: `would probe ${project ?? "?"} (${el} elapsed)`, stuck: false };

  if (!opts.prober || !project) {
    // No probe available. Do NOT guess — an unanswered question is not the same
    // as a dead session, and re-dispatching a live sweep would double-run it.
    return { note: `overrun (${el}) — no liveness probe available, leaving alone`, stuck: false };
  }

  const answer = await opts.prober.ask(
    project,
    `Are you still working on the task "${task.title}"? Reply in one short line.`
  );

  // Both of these are evidence of life. `busy` especially: it means AIBroker saw
  // the session actively producing output and deliberately sent nothing, so it
  // costs no tokens and must not count as a strike.
  if (answer.state === "replied" || answer.state === "busy") {
    state.failedProbes[task.id] = 0;

    const expected = expectedMinutes(state.history[task.id] ?? []);
    if (elapsed !== null && elapsed > expected * GROSS_OVERRUN_FACTOR) {
      // Alive but far past any plausible runtime. Do not recover it — killing a
      // working session is worse — but do not stay quiet either.
      return {
        note: `alive but ${el} against an expected ${expected}m — ${GROSS_OVERRUN_FACTOR}x over, worth a look`,
        stuck: true,
      };
    }

    return answer.state === "busy"
      ? { note: `busy after ${el} (mid-turn, nothing sent)`, stuck: false }
      : { note: `alive after ${el}: ${answer.reply ?? "(no detail)"}`, stuck: false };
  }

  const fails = (state.failedProbes[task.id] ?? 0) + 1;
  state.failedProbes[task.id] = fails;

  // `absent` is stronger evidence than `silent`, but not acted on immediately:
  // an empty session list is exactly how the hub failed on 2026-08-01, and
  // re-dispatching on a lying hub would spawn a duplicate tab per task.
  const what = answer.state === "absent" ? "session gone" : "no reply";

  if (fails >= STUCK_AFTER_FAILED_PROBES) {
    return {
      note: `STUCK after ${el} — ${what} x${fails} (${answer.reason ?? "no detail"})`,
      stuck: true,
    };
  }
  return { note: `${what} ${fails}/${STUCK_AFTER_FAILED_PROBES} after ${el}`, stuck: false };
}

export { isRunning };
