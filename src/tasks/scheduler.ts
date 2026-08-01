/**
 * scheduler.ts — Todoist-driven routine scheduler
 *
 * Todoist holds the schedule, the ordering, the dependencies and the run state.
 * This module is a dumb poller: it reads that state, decides what should happen
 * now, and reports. No LLM, so a tick costs nothing but an API call.
 *
 * Measured against the live Todoist API before this was written:
 *
 *   - Completing a recurring task does NOT create a new one. The SAME task
 *     rolls forward: same id, new due date, immediately unchecked. So "is it
 *     closed?" never detects completion for a recurring task — it is closed for
 *     an instant at most. Completion is "the due date advanced".
 *
 *   - Labels survive that roll-forward. A running marker will therefore NOT
 *     clear itself; the poller has to reconcile it, or the task looks
 *     permanently in flight and silently never runs again.
 *
 *   - Todoist never accumulates missed occurrences. Three days powered off
 *     leaves ONE overdue task, not three, and completing it jumps to the next
 *     future occurrence. There is no backlog to drain — but equally, Todoist
 *     cannot tell you how many windows were missed, so overdue-by-N is computed
 *     here.
 *
 *   - Writing `due_date` DESTROYS a recurrence rule, silently turning a routine
 *     into a one-off. This module must only ever write `due_string`.
 */

import type { Task } from "./types.js";

// ---------------------------------------------------------------------------
// Label vocabulary
// ---------------------------------------------------------------------------

/** Set when dispatched, cleared when the due date advances. */
export const RUNNING_LABEL = "pai-running";

/** Run however late. The default when nothing is specified. */
export const CATCHUP_LABEL = "pai-catchup";

/** `pai-skip-if-late:4h` — past that, the window is gone; wait for the next. */
const SKIP_IF_LATE_RE = /^pai-skip-if-late:(\d+)([hm])$/i;

/** Fallback when a task has no learned duration yet. */
export const DEFAULT_EXPECTED_MINUTES = 30;

/** Probe once the run exceeds expected x this. */
const PROBE_FACTOR = 1.5;

/** Consecutive unanswered probes before a run counts as stuck. */
export const STUCK_AFTER_FAILED_PROBES = 3;

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type Decision =
  /** Not due yet. */
  | { action: "wait"; task: Task }
  /** Due (or overdue within policy) and not running — dispatch it. */
  | { action: "dispatch"; task: Task; overdueMinutes: number }
  /** Overdue past its skip-if-late window — leave for the next occurrence. */
  | { action: "skip"; task: Task; reason: string }
  /** Running and within its expected duration — leave alone. */
  | { action: "running"; task: Task; elapsedMinutes: number }
  /** Running and overrun — ask the session whether it is alive. */
  | { action: "probe"; task: Task; elapsedMinutes: number; expectedMinutes: number }
  /** Was running, due date has advanced — it finished. */
  | { action: "complete"; task: Task; durationMinutes: number | null }
  /** Marked running but nothing knows about it — reconcile. */
  | { action: "orphaned"; task: Task; reason: string };

/** In-flight run bookkeeping. Transient: losing it costs one extra probe. */
export interface RunState {
  /** Task id → epoch ms when dispatched. */
  startedAt: Record<string, number>;
  /** Task id → consecutive probes with no reply. */
  failedProbes: Record<string, number>;
}

export const EMPTY_RUN_STATE: RunState = { startedAt: {}, failedProbes: {} };

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

export function isRunning(task: Task): boolean {
  return task.labels.some((l) => l.toLowerCase() === RUNNING_LABEL);
}

/** Minutes after which a missed window is abandoned, or null for "always run". */
export function skipIfLateMinutes(task: Task): number | null {
  for (const label of task.labels) {
    const m = SKIP_IF_LATE_RE.exec(label.trim());
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      return m[2]!.toLowerCase() === "h" ? n * 60 : n;
    }
  }
  return null;
}

/**
 * How overdue a task is, in minutes. Negative means still in the future.
 *
 * A date-only due ("2026-08-01") is treated as due at the start of that day,
 * which is what Todoist shows the user.
 */
export function overdueMinutes(task: Task, now: number): number {
  if (!task.due) return Number.NEGATIVE_INFINITY;
  const due = task.due.length <= 10 ? `${task.due}T00:00:00` : task.due;
  const dueMs = new Date(due).getTime();
  if (Number.isNaN(dueMs)) return Number.NEGATIVE_INFINITY;
  return Math.floor((now - dueMs) / 60_000);
}

// ---------------------------------------------------------------------------
// Duration learning
// ---------------------------------------------------------------------------

/**
 * Expected runtime for a task.
 *
 * The mean rather than the max, deliberately: with a liveness probe available,
 * guessing low costs one extra probe, while guessing high leaves a dead session
 * undetected for far longer. The probe is what makes a tight estimate safe.
 *
 * Runs that ended in stuck or re-dispatch must never be fed in here — one hung
 * run would inflate the mean and every later run would inherit a too-generous
 * threshold.
 */
export function expectedMinutes(observed: number[], fallback = DEFAULT_EXPECTED_MINUTES): number {
  const clean = observed.filter((n) => Number.isFinite(n) && n > 0);
  if (clean.length === 0) return fallback;
  const recent = clean.slice(-5);
  return Math.max(1, Math.round(recent.reduce((a, b) => a + b, 0) / recent.length));
}

// ---------------------------------------------------------------------------
// The decision function
// ---------------------------------------------------------------------------

export interface DecideOptions {
  now: number;
  state: RunState;
  /** Task id → observed durations in minutes, most recent last. */
  history?: Record<string, number[]>;
}

/**
 * Decide what should happen to one task on this tick.
 *
 * Pure: no I/O, no clock reads. Everything comes in via options so the state
 * machine can be tested against a fixed clock rather than by waiting.
 */
export function decide(task: Task, opts: DecideOptions): Decision {
  const { now, state } = opts;
  const running = isRunning(task);
  const overdue = overdueMinutes(task, now);
  const startedAt = state.startedAt[task.id];

  if (running) {
    // Completion is "the due date moved into the future" — not "closed".
    // A recurring task is closed for an instant at most, so testing for closed
    // would never fire.
    if (overdue < 0) {
      const duration = startedAt ? Math.max(1, Math.round((now - startedAt) / 60_000)) : null;
      return { action: "complete", task, durationMinutes: duration };
    }

    if (startedAt === undefined) {
      // Labelled running, but we have no record of starting it. Either the
      // state file was lost, or a previous run died without cleaning up.
      // Probing is the safe response — never assume it is dead and re-dispatch.
      return {
        action: "orphaned",
        task,
        reason: "marked running but no start time is known — probe before assuming anything",
      };
    }

    const elapsed = Math.max(0, Math.round((now - startedAt) / 60_000));
    const expected = expectedMinutes(opts.history?.[task.id] ?? []);
    if (elapsed >= expected * PROBE_FACTOR) {
      return { action: "probe", task, elapsedMinutes: elapsed, expectedMinutes: expected };
    }
    return { action: "running", task, elapsedMinutes: elapsed };
  }

  if (overdue < 0) return { action: "wait", task };

  const limit = skipIfLateMinutes(task);
  if (limit !== null && overdue > limit) {
    return {
      action: "skip",
      task,
      reason: `overdue by ${overdue}m, past its ${limit}m window — waiting for the next occurrence`,
    };
  }

  return { action: "dispatch", task, overdueMinutes: Math.max(0, overdue) };
}

/**
 * Order tasks for dispatch.
 *
 * Subtasks of the same parent run in Todoist's own order, so a routine is
 * sequenced by dragging its steps in the UI. Everything else falls back to
 * priority then due time, so the most overdue urgent thing goes first.
 */
export function dispatchOrder(tasks: Task[]): Task[] {
  const rank = { p1: 0, p2: 1, p3: 2, p4: 3 } as const;
  return [...tasks].sort((a, b) => {
    const p = rank[a.priority] - rank[b.priority];
    if (p !== 0) return p;
    return (a.due ?? "").localeCompare(b.due ?? "");
  });
}
