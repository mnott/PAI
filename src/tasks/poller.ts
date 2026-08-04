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
import { execFileSync } from "node:child_process";
import { readJsonStrict, writeJsonAtomic } from "../config/json-store.js";
import type { TodoistProvider } from "./providers/todoist.js";
import type { Transport } from "./dispatch.js";
import { dispatchTask } from "./dispatch.js";
import {
  decide,
  dispatchOrder,
  isRunning,
  isClaimedByAnyone,
  RUNNING_LABEL,
  STUCK_AFTER_FAILED_PROBES,
  type Decision,
  expectedMinutes,
  type RunState,
  EMPTY_RUN_STATE,
  wasTicked,
  restoreDueString,
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
  /**
   * Task id → consecutive dispatch attempts that did not land.
   *
   * Without this a task whose session has died to a shell is retried every
   * tick, forever, reporting the same failure each time and escalating never —
   * the "silently never runs" failure this whole subsystem exists to avoid.
   */
  failedDispatches: Record<string, number>;
  /**
   * Task id → epoch ms of the last time an alarm about it reached the user.
   *
   * Every tick that raised an alarm before this existed raised it into
   * /tmp/pai-scheduler.log and nowhere else. Measured 2026-08-03: the daily
   * check had logged "unrouted — cannot dispatch" 151 times across two days,
   * on a task whose whole purpose was to notice things failing silently.
   *
   * Kept per task, and honoured for a day, because the two wrong answers are
   * symmetric: notify every tick and the alarm is muted as noise within the
   * hour, notify once ever and a fault fixed-then-reintroduced is silent the
   * second time.
   */
  alarmedAt: Record<string, number>;
  /**
   * Task id → the due date this tick saw.
   *
   * Durable rather than transient, unlike the rest of this file: it is the only
   * record that a recurring task's due date moved, and a lost entry means the
   * next tick cannot tell a hand-ticked task from one that was never due. That
   * costs a missed run, not a wrong one — the first tick after a reset simply
   * re-learns every date and triggers nothing.
   */
  lastSeenDue: Record<string, string>;
  /**
   * Task id → the due_string a hand-triggered run has to get back.
   *
   * Restoring once at trigger time is not enough. The session ends its run with
   * `pai task done`, which advances the recurrence a second time — so a sweep
   * run by hand on Saturday evening silently ate Sunday morning's scheduled
   * one. Held here until the completion is seen, then re-applied.
   */
  triggeredRestore: Record<string, string>;
  /**
   * Task id → when this poller first saw a running claim on it.
   *
   * The claim is no longer only ours to make — AIBroker's webhook claims and
   * dispatches on its own — so a claimed task often has no start time here.
   * This dates those runs, which is what lets them age out instead of holding
   * the interlock forever, and what separates a claim we have been watching
   * from one appearing for the first time.
   */
  claimSeenAt: Record<string, number>;
}

/**
 * A fresh blank state, built per call rather than shared.
 *
 * This was a module-level constant spread into every load. A spread is shallow,
 * so any field the persisted file did not carry — a fresh install, or a file
 * written before that field existed — aliased the constant's own object, and
 * writes to it leaked into every later load in the process. Harmless for the
 * launchd tick, which loads once and exits, and quietly wrong everywhere else:
 * it made test runs contaminate each other and would do the same to any caller
 * that ticked twice.
 */
function emptyState(): PersistedState {
  return {
    startedAt: {},
    failedProbes: {},
    history: {},
    lastReported: {},
    failedDispatches: {},
    alarmedAt: {},
    lastSeenDue: {},
    triggeredRestore: {},
    claimSeenAt: {},
  };
}

/** Consecutive failed dispatches before a task is reported as needing attention. */
const DISPATCH_FAILURES_BEFORE_ALARM = 3;

/** How long an alarm about one task stays quiet before it is repeated. */
const ALARM_REPEAT_MS = 24 * 60 * 60 * 1000;

/**
 * Tell the user about a task that is scheduled and not running.
 *
 * The counterpart of the storage-backend escalation: a subsystem whose entire
 * job is noticing silent failure has to be the last thing that fails silently.
 * `report.stuck` counted these accurately and showed the count in a CLI line
 * that only appears if somebody runs a tick by hand — which, for a job launchd
 * runs every 15 minutes, is nobody.
 *
 * Never allowed to throw: a notification that cannot be delivered must not take
 * down the tick, because the tick is what dispatches everything else.
 */
async function escalate(
  task: Task,
  headline: string,
  detail: string,
  state: PersistedState,
  now: number
): Promise<void> {
  const last = state.alarmedAt[task.id];
  if (last !== undefined && now - last < ALARM_REPEAT_MS) return;
  state.alarmedAt[task.id] = now;

  try {
    const { routeNotification } = await import("../notifications/router.js");
    const { loadConfig } = await import("../daemon/config.js");
    await routeNotification(
      {
        event: "error",
        title: `PAI: ${headline}`,
        message: `"${task.content}" ${detail}`,
      },
      loadConfig().notifications
    );
  } catch {
    /* see above — the tick matters more than the notification */
  }
}

/**
 * Run state is a rebuildable cache, so a damaged file must not block the
 * scheduler forever — starting fresh is the correct recovery here, which is
 * exactly the case json-store's guard is NOT for.
 */
function loadState(file: string): PersistedState {
  try {
    const raw = readJsonStrict(file, "~/.pai/scheduler-state.json");
    return { ...emptyState(), ...(raw as unknown as PersistedState) };
  } catch {
    return emptyState();
  }
}

function saveState(state: PersistedState, file: string): void {
  writeJsonAtomic(file, state as unknown as Record<string, unknown>, { backup: false });
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
  /**
   * Where run state is persisted. Overridable so the dispatch path can be
   * tested at all: a real tick writes to disk, and the alternative — asserting
   * only through `dryRun` — skips the transport entirely, which is precisely
   * the code that misreported a delivered task as failed.
   */
  stateFile?: string;
  /**
   * Override webhook detection. Left unset, the tick asks AIBroker once.
   *
   * Present so tests can pin both sides of the precedence rule without a live
   * daemon — the whole point of the flag is which of two subsystems decides,
   * and that is not testable if it can only be discovered by shelling out.
   */
  webhookActive?: boolean;
}

export interface TickReport {
  decisions: Array<{ decision: Decision; note: string }>;
  dispatched: number;
  completed: number;
  stuck: number;
  probed: number;
}

/**
 * Is a tracker webhook delivering completion events on this machine?
 *
 * Asked of AIBroker, which owns the receiver: `todoist status` reports whether
 * an OAuth grant is on file, and without a grant no completion events arrive.
 * Deliberately conservative — anything unexpected reads as "no webhook", which
 * leaves the due-date inference running. That is the pre-existing behaviour and
 * degrades to guessing rather than to silence.
 *
 * Cheap enough to run per tick (one short-lived process, once), and read live
 * rather than cached because a grant can lapse at any moment — that happened
 * mid-afternoon on 2026-08-01, and a cached "yes" would have suppressed the
 * fallback exactly when it was needed.
 */
function detectWebhook(bin = "aibroker"): boolean {
  try {
    const out = execFileSync(bin, ["todoist", "status"], {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A grant on file is the only thing that matters; without one the receiver
    // can verify webhooks but cannot resolve them, so no completion lands.
    return /authoris|authoriz|token on file|grant/i.test(out) && !/no (token|grant)/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Discard restore entries whose run is no longer in flight.
 *
 * `triggeredRestore` belongs to one run: it records the occurrence that run
 * consumed, to be handed back when the run completes. It was only ever consumed
 * on the completion path, so a run that ended any other way — abandoned, or
 * released by hand — left the entry behind, and it then fired on that task's
 * NEXT completion, whenever that came.
 *
 * Observed 2026-08-02: runs ended by hand the previous night left entries that
 * fired on the first unattended 08:00 completion and wrote the due date from
 * 08-03 back to 08-02. That date was already past, so the task was instantly
 * overdue and the following tick would have dispatched a duplicate sweep.
 *
 * Clearing it at each release site would work, and would have to be remembered
 * at every site added later. Deriving it instead makes the class unreachable:
 * an entry with no claim behind it describes a run that is over, whatever ended
 * it. The claim is the only thing that says a run is still in flight.
 */
function dropOrphanedRestores(tasks: Task[], state: PersistedState): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const id of Object.keys(state.triggeredRestore)) {
    const task = byId.get(id);

    // Gone from the open list entirely — nothing will complete it again.
    if (!task) {
      delete state.triggeredRestore[id];
      continue;
    }

    // Liveness means "a run is in flight at all", not "a run we started" —
    // a webhook-triggered run is claimed before this poller sees the task, so
    // keying on our own startedAt would discard exactly the entries the webhook
    // path depends on, one tick after recording them.
    if (!isClaimedByAnyone(task, state)) {
      delete state.triggeredRestore[id];
    }
  }
}

export async function tick(opts: TickOptions): Promise<TickReport> {
  const now = opts.now ?? Date.now();
  const stateFile = opts.stateFile ?? STATE_FILE;
  const state = loadState(stateFile);
  const report: TickReport = { decisions: [], dispatched: 0, completed: 0, stuck: 0, probed: 0 };

  const tasks = await opts.provider.listOpen({ includeUnrouted: true });
  const ordered = dispatchOrder(tasks);

  if (!opts.dryRun) dropOrphanedRestores(tasks, state);

  // Resolved once per tick, not per task: it is a property of the machine.
  const webhookActive = opts.webhookActive ?? detectWebhook();

  for (const task of ordered) {
    // Captured before lastSeenDue is overwritten below — both the trigger
    // detection and the webhook-trigger signature need the PREVIOUS tick's value.
    const prevDue = state.lastSeenDue[task.id];

    const d = decide(task, {
      now,
      state,
      history: state.history,
      lastSeenDue: state.lastSeenDue,
      claimSeenAt: state.claimSeenAt,
      webhookActive,
    });
    let note = "";

    // Recorded for every task on every tick, whatever was decided — the next
    // tick's ability to spot a hand-ticked task depends on it, and skipping the
    // uninteresting cases is what would leave that blind.
    if (!opts.dryRun && task.due) state.lastSeenDue[task.id] = task.due;

    // Dated on first sight and dropped the moment the claim clears, so the next
    // claim on the same task is timed from when IT appeared rather than from a
    // stale entry belonging to a previous run.
    if (!opts.dryRun) {
      if (isRunning(task)) {
        // A claim appearing at the same moment the due date advanced by exactly
        // one period is the signature of a webhook-triggered run: the user
        // ticked the box, AIBroker claimed it and dispatched, all before this
        // tick. Recorded so the occurrence the tick consumed is given back after
        // the run, the same as for a trigger this poller handled itself.
        //
        // Recorded ONLY — the date is not written back now. AIBroker decides
        // whether the session may release its claim by checking that the due
        // date has advanced past the occurrence it noted when claiming, so
        // moving that date mid-run would make a finished run look unfinished
        // and strand the claim.
        if (state.claimSeenAt[task.id] === undefined && task.recurrence && prevDue !== undefined) {
          if (wasTicked(task, prevDue)) {
            state.triggeredRestore[task.id] = restoreDueString(task.recurrence, prevDue);
          }
        }
        state.claimSeenAt[task.id] ??= now;
      } else {
        delete state.claimSeenAt[task.id];
      }
    }

    switch (d.action) {
      case "wait":
        continue; // not worth reporting

      case "triggered": {
        const r = await handleDispatch(task, 0, opts, state, now);
        note = `ticked off by hand — ${r.note}`;
        if (!opts.dryRun) {
          report.dispatched++;
          if (r.alarm) report.stuck++;
          note += await restoreSchedule(task, d.restoreTo, opts, state);
          // Held for the completion, which advances the recurrence again.
          if (d.restoreTo) state.triggeredRestore[task.id] = d.restoreTo;
        }
        break;
      }

      case "skip":
        note = d.reason;
        break;

      case "running":
        note = `${d.elapsedMinutes}m elapsed`;
        break;

      case "dispatch": {
        const r = await handleDispatch(task, d.overdueMinutes, opts, state, now);
        note = r.note;
        if (!opts.dryRun) {
          report.dispatched++;
          if (r.alarm) report.stuck++;
        }
        break;
      }

      case "complete":
        note = await handleComplete(task, d.durationMinutes, opts, state, now);
        if (!opts.dryRun) report.completed++;
        break;

      case "abandoned": {
        note = `claimed ${d.elapsedMinutes}m ago, past the ${d.thresholdMinutes}m limit — releasing the claim`;
        if (!opts.dryRun) {
          await opts.provider.setLabels(
            task.id,
            task.labels.filter((l) => l.toLowerCase() !== RUNNING_LABEL)
          );
          delete state.startedAt[task.id];
          delete state.failedProbes[task.id];
          delete state.claimSeenAt[task.id];
          await clearRunningMark(task, opts);
          // Reported as needing attention: a run that had to be released this
          // way did not finish, and the next tick re-dispatching it is a repair,
          // not business as usual.
          report.stuck++;
        }
        break;
      }

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

  if (!opts.dryRun) saveState(state, stateFile);
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
): Promise<{ note: string; alarm: boolean }> {
  const late = overdue > 5 ? ` (${overdue}m late)` : "";
  if (opts.dryRun) {
    return { note: `would dispatch to ${task.owner.project ?? "nobody"}${late}`, alarm: false };
  }

  // Reaching here at all means the task is DUE: an undated task scores
  // NEGATIVE_INFINITY overdue and is decided as `wait`, so it never arrives.
  // That is what separates this from the findings inbox, where UNROUTED is the
  // normal resting state and alarming would be pure noise — a finding carries
  // no date and makes no promise. A task with a due date does: it claims it
  // will run, and unrouted means it never can, by itself, ever.
  //
  // So this is the one dispatch failure that retrying cannot fix, and it used
  // to be the only one that did not alarm. The daily check sat here from
  // 2026-08-01 to 2026-08-03 reading "recurring, every day at 9am" while doing
  // nothing, and was found by a human reading the tracker, not by this code.
  if (!task.owner.project) {
    const hint = task.owner.rawHint ? ` (${task.owner.rawHint} matches no project)` : "";
    await escalate(
      task,
      "scheduled task cannot run",
      `is due${late} but has no owner${hint}, so nothing will ever pick it up. ` +
        `Move it into a session's sub-project, or give that container an alias.`,
      state,
      now
    );
    return { note: `unrouted — cannot dispatch${hint}${late}`, alarm: true };
  }

  // Claim the task BEFORE dispatching, not after.
  //
  // This label is now the interlock between two independent dispatchers: this
  // poller, and AIBroker's Todoist webhook, which fires on item:completed and
  // skips any task already carrying it (aibroker 0.17.0). Setting it after the
  // dispatch returned would leave a window — the whole length of a spawn — in
  // which the webhook sees an unclaimed task and sends the same work order a
  // second time. It was previously written only for crash visibility, where
  // "after" was harmless; it is load-bearing now, so it has to come first.
  //
  // The cost is a label to undo when the dispatch does not land, which is the
  // cheaper failure: a task wrongly marked running is visible and self-clears
  // below, whereas a double-dispatched sweep reads Gmail twice and mails twice.
  const claimed = [...task.labels, RUNNING_LABEL];
  await opts.provider.setLabels(task.id, claimed);

  const result = await dispatchTask(task, {
    transport: opts.transport,
    autoDispatch: opts.autoDispatch,
    spawnIfAbsent: true,
  });

  // `queued` counts as delivery. The message is sitting in a live session's
  // input box; Claude Code simply will not read it until the current turn ends.
  // Treating it as a failure marked a sweep NOT RUNNING while it was running,
  // and left the task without its running label so a later tick could send it
  // again — the same reasoning that makes `busy` positive evidence on the probe
  // path, where a working session is exactly the one that cannot answer.
  if (result.outcome === "delivered" || result.outcome === "queued" || result.outcome === "spawned") {
    state.startedAt[task.id] = now;
    delete state.failedProbes[task.id];
    delete state.failedDispatches[task.id];
    // Dropped on success so the day-long quiet window never outlives the fault
    // it described: a task fixed this morning and broken again tonight alarms
    // tonight, rather than staying muted until tomorrow.
    delete state.alarmedAt[task.id];
    await markRunning(task, opts, now);
    return { note: `${result.outcome} to ${result.session}${late}`, alarm: false };
  }

  // Nothing is running, so release the claim — otherwise the task looks in
  // flight forever and the next tick reports it orphaned rather than retrying.
  await opts.provider.setLabels(task.id, task.labels);
  await clearRunningMark(task, opts);

  const fails = (state.failedDispatches[task.id] ?? 0) + 1;
  state.failedDispatches[task.id] = fails;
  const detail = `${result.outcome}${result.reason ? " — " + result.reason : ""}`;

  if (fails >= DISPATCH_FAILURES_BEFORE_ALARM) {
    // `unreachable` against a session that has exited to a shell will never
    // resolve on its own: aibroker correctly refuses to type into it, and
    // nothing here can close the tab. Retrying quietly forever is the failure.
    await escalate(
      task,
      "task is not running",
      `failed to dispatch ${fails} times (${detail}). It is scheduled and nothing is executing it.`,
      state,
      now
    );
    return {
      note: `NOT RUNNING — ${fails} failed dispatches: ${detail}`,
      alarm: true,
    };
  }
  return { note: `not dispatched (${fails}/${DISPATCH_FAILURES_BEFORE_ALARM}): ${detail}`, alarm: false };
}

/**
 * First line of the progress comment, and the only way it is ever found again.
 *
 * Deliberately matched by content rather than by a stored comment id. An id in
 * the state file is one more thing that goes stale — lose the file and the
 * comment is orphaned with nothing able to remove it. A sentinel is
 * self-healing: any later release finds and clears it, whatever happened in
 * between, and clearing is idempotent so doing it twice costs nothing.
 */
const RUNNING_COMMENT_MARK = "**RUNNING**";

/**
 * Post the human-facing progress marker.
 *
 * This is NOT an interlock and nothing may ever decide from it. `pai-running`
 * is the machine-readable claim and both dispatchers read that alone. Two
 * mechanisms tracking one piece of state and disagreeing is the shape of every
 * defect found on 2026-08-01; this stays purely informational so it cannot
 * become the sixth.
 *
 * Failure is swallowed on purpose. A comment that could not be posted must not
 * cost the run — the sweep matters, the annotation does not.
 */
async function markRunning(task: Task, opts: TickOptions, startedAt: number): Promise<void> {
  if (!opts.provider.comment) return;
  const when = new Date(startedAt).toISOString().replace("T", " ").slice(0, 16);
  try {
    // Kept to one line on purpose. The first version explained the interlock
    // design here and read as noise to the person it was written for — a
    // progress marker's job is to say it is running, not to document why.
    await opts.provider.comment(
      task.id,
      `${RUNNING_COMMENT_MARK} — started ${when} UTC, ${task.owner.project}. Disappears when it finishes.`
    );
  } catch {
    // Deliberately silent: see above.
  }
}

/**
 * Remove any progress marker left on a task.
 *
 * Called from every path that releases the claim, including the ones that
 * release it because something went wrong. A marker outliving its run is
 * exactly the stale-state problem this whole subsystem keeps producing, so the
 * cleanup is attached to the release rather than to the happy path.
 */
async function clearRunningMark(task: Task, opts: TickOptions): Promise<void> {
  const { listComments, deleteComment } = opts.provider;
  if (!listComments || !deleteComment) return;
  try {
    const comments = await listComments.call(opts.provider, task.id);
    for (const c of comments) {
      if (c.content.startsWith(RUNNING_COMMENT_MARK)) {
        await deleteComment.call(opts.provider, c.id);
      }
    }
  } catch {
    // Same reasoning as posting it: never let the annotation break the run.
  }
}

/**
 * Put a hand-ticked task's schedule back.
 *
 * Deliberately after the dispatch and never in its place: the run is the point,
 * and a tracker that refuses the write must not cost the user the sweep they
 * asked for. A failure here is reported and nothing else — the task simply
 * keeps the advanced date, which is where it would have stayed anyway.
 */
async function restoreSchedule(
  task: Task,
  restoreTo: string | null,
  opts: TickOptions,
  state: PersistedState
): Promise<string> {
  if (!restoreTo) return ", schedule left at the next occurrence";
  if (!opts.provider.setDue) return ", schedule unchanged (provider cannot rewrite due dates)";

  try {
    await opts.provider.setDue(task.id, restoreTo);
    // Record what we wrote, not what we read — the next tick must compare
    // against the restored date or it would read the restore as a fresh jump.
    const restoredDate = /starting (\d{4}-\d{2}-\d{2})/.exec(restoreTo)?.[1];
    if (restoredDate) state.lastSeenDue[task.id] = restoredDate;
    return `, schedule restored (${restoreTo})`;
  } catch (e) {
    return `, could NOT restore the schedule: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function handleComplete(
  task: Task,
  durationMinutes: number | null,
  opts: TickOptions,
  state: PersistedState,
  now: number
): Promise<string> {
  if (opts.dryRun) return `would clear ${RUNNING_LABEL}, ${durationMinutes ?? "?"}m`;

  await opts.provider.setLabels(
    task.id,
    task.labels.filter((l) => l.toLowerCase() !== RUNNING_LABEL)
  );

  await clearRunningMark(task, opts);

  const wasStuck = (state.failedProbes[task.id] ?? 0) > 0;
  delete state.startedAt[task.id];
  delete state.failedProbes[task.id];
  delete state.claimSeenAt[task.id];

  // A run that needed probing may have been stalled for most of its wall time.
  // Feeding that into the average would inflate every later threshold.
  if (durationMinutes !== null && !wasStuck) {
    const hist = state.history[task.id] ?? [];
    hist.push(durationMinutes);
    state.history[task.id] = hist.slice(-HISTORY_LIMIT);
  }

  const base =
    durationMinutes === null
      ? "completed (duration unknown)"
      : `completed in ${durationMinutes}m${wasStuck ? " — not recorded, run was probed" : ""}`;

  return base + (await keepTriggeredSchedule(task, opts, state, now));
}

/**
 * Give a hand-triggered run its schedule back, a second time.
 *
 * `pai task done` is the correct way to end a recurring run — the roll-forward
 * is how completion is detected at all — but it advances the date on top of the
 * advance the hand-tick already caused. Without this, using the checkbox as a
 * Run Now button quietly cancelled the next scheduled occurrence, which is the
 * exact behaviour the restore was added to prevent.
 *
 * Skipped when the slot has already passed: re-applying it would produce a task
 * that is overdue the moment it is written, and the next tick would dispatch it.
 */
async function keepTriggeredSchedule(
  task: Task,
  opts: TickOptions,
  state: PersistedState,
  now: number
): Promise<string> {
  const keep = state.triggeredRestore[task.id];
  if (!keep) return "";
  delete state.triggeredRestore[task.id];

  const date = /starting (\d{4}-\d{2}-\d{2})/.exec(keep)?.[1];
  if (!date || !opts.provider.setDue) return "";
  if (new Date(`${date}T23:59:59`).getTime() <= now) {
    return ", triggered-run slot already past — schedule left as it is";
  }

  try {
    await opts.provider.setDue(task.id, keep);
    state.lastSeenDue[task.id] = date;
    return `, schedule kept at ${date} (run was hand-triggered)`;
  } catch (e) {
    return `, could NOT keep the schedule: ${e instanceof Error ? e.message : String(e)}`;
  }
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
