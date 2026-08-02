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

/**
 * Multiples of the expected duration after which a claim is released outright.
 *
 * The running label became an interlock once AIBroker's webhook started skipping
 * any task carrying it (0.17.1). That closed the duplicate-dispatch hole and
 * opened a worse one: nothing here ever took the label off except a completion,
 * so a session that died mid-turn left the task claimed forever — the webhook
 * skipping it, the poller probing it, and neither ever running it again. Silent
 * permanent non-execution is the exact failure this subsystem exists to prevent,
 * and it is worse than a duplicate run.
 *
 * Deliberately far beyond the probe threshold and NOT conditional on a probe
 * saying the session is gone. An empty session list is how the hub itself failed
 * on 2026-08-01, so "absent" is not trustworthy evidence; elapsed time is. A
 * sweep that has been in flight for five hours is not in flight.
 */
export const ABANDON_FACTOR = 10;

/** Floor for the same, so a task with a short learned duration is not released early. */
export const ABANDON_FLOOR_MINUTES = 120;

/** When a claim is old enough to be released regardless of what probes say. */
export function abandonAfterMinutes(observed: number[]): number {
  return Math.max(expectedMinutes(observed) * ABANDON_FACTOR, ABANDON_FLOOR_MINUTES);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type Decision =
  /** Not due yet. */
  | { action: "wait"; task: Task }
  /**
   * Ticked off in the tracker by hand — run it now, and put the schedule back.
   *
   * `restoreTo` is the due_string to write afterwards, or null to leave the
   * advanced date alone (the occurrence that was just consumed is already past,
   * so restoring it would only produce an immediately-overdue task).
   */
  | { action: "triggered"; task: Task; restoreTo: string | null }
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
  /**
   * Claimed so long ago that no run is plausibly still going — release it.
   *
   * Not a re-dispatch: the claim comes off and nothing else happens this tick.
   * The task is still overdue, so the next tick dispatches it through the normal
   * path, claim and all. Splitting it that way keeps one dispatcher.
   */
  | { action: "abandoned"; task: Task; elapsedMinutes: number; thresholdMinutes: number }
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

/**
 * Did THIS poller start the run currently in flight?
 *
 * The distinction from {@link isClaimedByAnyone} has now caused three separate
 * defects in three functions across two days, so it is named rather than
 * re-derived from `startedAt` at each site.
 *
 * `startedAt` is set only when this poller dispatches. A run triggered through
 * the tracker's webhook is claimed by AIBroker before this poller ever sees the
 * task, so it has no `startedAt` here — and every piece of evidence that is
 * sound for our own runs is worthless for those. Twice that produced a
 * confident wrong answer: `overdue < 0` reported a webhook run finished on the
 * tick after it started, and an orphan sweep keyed on `startedAt` would have
 * discarded exactly the entries the webhook path depends on.
 *
 * Use this when the question is "can I trust state I recorded myself".
 */
export function isOurRun(state: RunState, taskId: string): boolean {
  return state.startedAt[taskId] !== undefined;
}

/**
 * Is anyone running this task — us, or a session claimed through the tracker?
 *
 * The RUNNING label is the shared interlock: whoever claims a task sets it,
 * whichever side they are. Use this when the question is "is a run in flight at
 * all", which is what liveness means for anything scoped to a run.
 */
export function isClaimedByAnyone(task: Task, state: RunState): boolean {
  return isRunning(task) || isOurRun(state, task.id);
}

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
// Manual trigger (the checkbox as a Run Now button)
// ---------------------------------------------------------------------------

/**
 * Why this is inferred from the due date rather than observed directly:
 *
 * Completing a recurring task leaves no completion event anywhere the API will
 * show us. Measured 2026-08-01 against the live account — a recurring task was
 * created, completed, and then queried through the completed-by-completion-date
 * endpoint: it is absent. The task itself comes straight back as open with the
 * due date advanced and the same id. So "the due date jumped forward while we
 * were not running it" is the ONLY evidence a human ticked the box.
 *
 * That evidence is ambiguous — dragging the date forward looks identical — so
 * the jump is checked against the recurrence period before it is believed. A
 * daily task that moves by exactly one day was ticked; one that moves by three
 * was rescheduled, and firing a sweep on that would both waste a run and undo
 * the user's edit.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Day-deltas consistent with one occurrence of `recurrence` elapsing.
 *
 * A set rather than a number because real rules are not fixed-length: a monthly
 * task advances by 28 to 31 days, and "every weekday" by one to three. Null
 * means the rule was not recognised, which the caller treats as permissive —
 * an unrecognised recurrence is still a recurrence, and refusing to fire is the
 * failure mode this whole mechanism exists to remove.
 */
export function expectedAdvanceDays(recurrence: string | null | undefined): number[] | null {
  if (!recurrence) return null;
  const r = recurrence.trim().toLowerCase();

  if (/\bevery\s+(work ?day|weekday)/.test(r)) return [1, 2, 3];
  if (/\bevery\s+other\s+day\b/.test(r)) return [2];
  if (/\bevery\s+(\d+)\s+days?\b/.test(r)) {
    const n = Number.parseInt(/\bevery\s+(\d+)\s+days?\b/.exec(r)![1]!, 10);
    return n > 0 ? [n] : null;
  }
  if (/\bevery\s+day\b/.test(r) || /\bdaily\b/.test(r)) return [1];
  if (/\bevery\s+(\d+)\s+weeks?\b/.test(r)) {
    const n = Number.parseInt(/\bevery\s+(\d+)\s+weeks?\b/.exec(r)![1]!, 10);
    return n > 0 ? [n * 7] : null;
  }
  // Before the weekday rule: an unanchored "mon" alternative also matches the
  // "mon" in "month", which classified a monthly routine as weekly.
  if (/\bevery\s+(month|\d+\s+months?)\b/.test(r) || /\bmonthly\b/.test(r)) return [28, 29, 30, 31];
  if (/\bevery\s+year\b/.test(r) || /\byearly\b/.test(r) || /\bannually\b/.test(r)) return [365, 366];
  if (
    /\bevery\s+(?:week|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.test(r) ||
    /\bweekly\b/.test(r)
  ) {
    return [7];
  }

  return null;
}

/** Whole days between two due values, rounded — times of day are preserved by
 *  both a completion and a drag, so they carry no signal either way. */
function advanceDays(prevDue: string, newDue: string): number {
  const a = new Date(prevDue.length <= 10 ? `${prevDue}T00:00:00` : prevDue).getTime();
  const b = new Date(newDue.length <= 10 ? `${newDue}T00:00:00` : newDue).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Did this task advance because someone ticked it off?
 *
 * A non-recurring task is never a trigger: completing one closes it, and it
 * drops out of the open list rather than reappearing with a later date. So a
 * forward jump there is unambiguously a reschedule.
 */
export function wasTicked(task: Task, prevDue: string | null | undefined): boolean {
  if (!prevDue || !task.due || !task.recurrence) return false;
  if (task.due <= prevDue) return false;

  const moved = advanceDays(prevDue, task.due);
  if (!Number.isFinite(moved) || moved <= 0) return false;

  const expected = expectedAdvanceDays(task.recurrence);
  return expected === null ? true : expected.includes(moved);
}

/**
 * The due_string that puts a ticked task back where it was.
 *
 * Rule and date in one string on purpose. Writing the date alone through the
 * tracker's date field drops the recurrence and quietly demotes a routine to a
 * one-off — the failure the provider's `setDue` comment warns about. Todoist
 * parses "every day at 08:00 starting 2026-08-02" and honours both halves;
 * verified against the live API on 2026-08-01.
 */
export function restoreDueString(recurrence: string, prevDue: string): string {
  const date = prevDue.slice(0, 10);
  const hasTime = prevDue.length > 10;
  const ruleCarriesTime = /\bat\s+\d/.test(recurrence);

  // "every day" plus a datetime due would come back as a date-only occurrence,
  // losing the time of day. Carry it explicitly when the rule does not.
  const time = hasTime && !ruleCarriesTime ? ` at ${prevDue.slice(11, 16)}` : "";
  return `${recurrence}${time} starting ${date}`;
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
  /**
   * Task id → the due date seen on the previous tick.
   *
   * The only way to notice a task was ticked off by hand. Absent on the first
   * tick after install, which is why a missing entry can never mean "it moved".
   */
  lastSeenDue?: Record<string, string>;
  /**
   * True when a tracker webhook is delivering completion events.
   *
   * When set, the due-date trigger inference is switched off: the webhook sees
   * the real event, so the guess can only add false positives. Defaults to
   * false so a machine with no webhook keeps the fallback — which is the case
   * the inference was written for.
   */
  webhookActive?: boolean;
  /**
   * Task id → when this poller FIRST saw the task carrying a running claim.
   *
   * Needed because the claim is no longer only ours to make: AIBroker's webhook
   * claims and dispatches on its own, so a claimed task frequently has no start
   * time here. This is the clock for those runs — both to age them out and to
   * tell a claim we have been watching from one we are seeing for the first time.
   */
  claimSeenAt?: Record<string, number>;
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
    const claimSeenAt = opts.claimSeenAt?.[task.id];
    const prevDue = opts.lastSeenDue?.[task.id];
    const dueAdvanced = prevDue !== undefined && task.due !== null && task.due > prevDue;
    const ourRun = isOurRun(state, task.id);

    // Completion is "the due date moved into the future" — not "closed". A
    // recurring task is closed for an instant at most, so testing for closed
    // would never fire.
    //
    // But `overdue < 0` alone is only evidence for a run WE started. A run
    // dispatched by AIBroker's webhook is triggered by the user ticking the box,
    // which advances the due date before the run even begins — so the due sits
    // in the future for the whole run, and this branch reported it finished on
    // the very next tick and stripped the interlock mid-flight. Measured against
    // a live probe on 2026-08-01: "✓ would clear pai-running" while the sweep
    // was still going.
    //
    // For someone else's run the completion signal is the due date advancing
    // AGAIN — and only once we have watched the claim across a tick, since the
    // first advance we see is the trigger itself, not an ending.
    const finishedElsewhere = dueAdvanced && claimSeenAt !== undefined && claimSeenAt < now;

    if ((ourRun && overdue < 0) || finishedElsewhere) {
      const duration = startedAt ? Math.max(1, Math.round((now - startedAt) / 60_000)) : null;
      return { action: "complete", task, durationMinutes: duration };
    }

    // Clock for everything below. A claim we did not make still has to age out,
    // or a webhook run whose session died would hold the interlock forever.
    const clock = startedAt ?? claimSeenAt;
    if (clock === undefined) {
      // First sighting of a claim with nothing to date it by. Either the state
      // file was lost or another dispatcher just claimed it. Probing is the safe
      // response — never assume it is dead and re-dispatch. The next tick has a
      // claim time and can age it properly.
      return {
        action: "orphaned",
        task,
        reason: "marked running but no start time is known — probe before assuming anything",
      };
    }

    const elapsed = Math.max(0, Math.round((now - clock) / 60_000));
    const expected = expectedMinutes(opts.history?.[task.id] ?? []);

    // Checked before probing: past this point the probe's answer no longer
    // changes what should happen. Even a session replying "yes, still working"
    // has been working ten times its usual run, and leaving the claim on is what
    // turns one dead session into a routine that never runs again.
    const abandonAfter = abandonAfterMinutes(opts.history?.[task.id] ?? []);
    if (elapsed >= abandonAfter) {
      return { action: "abandoned", task, elapsedMinutes: elapsed, thresholdMinutes: abandonAfter };
    }

    // Only interrogate our own runs. Asking after a session another dispatcher
    // started tells us nothing actionable — we would not re-dispatch it either
    // way — and the ageing above already bounds it.
    if (!ourRun) return { action: "running", task, elapsedMinutes: elapsed };

    if (elapsed >= expected * PROBE_FACTOR) {
      return { action: "probe", task, elapsedMinutes: elapsed, expectedMinutes: expected };
    }
    return { action: "running", task, elapsedMinutes: elapsed };
  }

  // Checked before the wait branch, because a task that was just ticked always
  // lands in the future — it would otherwise be indistinguishable from one that
  // is simply not due yet, which is exactly how the checkbox came to look like
  // a button that silently pushed the sweep out by a day.
  const prevDue = opts.lastSeenDue?.[task.id];

  // A claim we were watching until a moment ago means this advance is a run
  // ENDING, not a box being ticked. Since aibroker 0.17.4 the finishing session
  // drops the claim itself and then advances the recurrence with `pai task
  // done` — so by the next tick the task is unclaimed with its due date exactly
  // one period on, which is indistinguishable from a hand-tick and would have
  // dispatched the same work a second time.
  //
  // The entry is still here because tick() clears it AFTER deciding, which is
  // precisely the window this needs. When a whole run fits between two ticks we
  // never see the claim at all — but then the due has advanced twice, once for
  // the trigger and once for the completion, and the period check rejects it.
  const wasClaimed = opts.claimSeenAt?.[task.id] !== undefined;

  // Suppressed entirely where a webhook is live, and that is a deliberate
  // precedence decision rather than a tuning knob.
  //
  // The inference reads "due advanced by exactly one period, unclaimed" as a
  // tick. For a DAILY recurrence that is byte-identical to a human dragging the
  // task forward one day, and to this poller repairing a due date it wrote
  // wrongly itself. There is no local signal that separates them — it is an
  // irreducible false positive, not something a tighter check can remove.
  //
  // A webhook has the actual item:completed event and no ambiguity at all. So
  // where one is running, guessing is strictly worse than not guessing, and
  // leaving both active means the fallback keeps firing on reschedules the
  // webhook correctly ignored — which is how repairing one duplicate sweep
  // produced a second on 2026-08-02.
  //
  // The costs are asymmetric, which is what settles it. A false positive
  // dispatches real work nobody asked for — a sweep that scrapes, writes and
  // sends mail. A false negative merely delays a hand-triggered run until the
  // next tick, which then dispatches it on the ordinary overdue path. Guessing
  // wrong in the expensive direction to save minutes in the cheap one is a bad
  // trade wherever the unambiguous signal exists.
  if (!opts.webhookActive && !wasClaimed && wasTicked(task, prevDue)) {
    // Restore only a slot that has not passed. Putting back an occurrence that
    // is already overdue leaves a task that reads as late the instant it is
    // written, for a run that is starting right now.
    const prevMs = new Date(prevDue!.length <= 10 ? `${prevDue}T00:00:00` : prevDue!).getTime();
    const restoreTo =
      task.recurrence && prevMs > now ? restoreDueString(task.recurrence, prevDue!) : null;
    return { action: "triggered", task, restoreTo };
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
