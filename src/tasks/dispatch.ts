/**
 * dispatch.ts — Hand tasks to the PAI session that owns them
 *
 * Transport is AIBroker, and it is optional. With it, a task reaches a running
 * session or spawns one. Without it, dispatch degrades to reporting who owns
 * what and leaves acting to the user — PAI must stay useful on machines that
 * do not run iTerm2.
 *
 * See Notes/docs/task-bus.md.
 */

import type { DispatchResult, Task } from "./types.js";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What a transport reports back. Mirrors DispatchOutcome minus the states
 *  the bus decides for itself (`unrouted`, and `skipped` when disabled). */
export interface TransportResult {
  outcome: "delivered" | "queued" | "spawned" | "unlaunchable" | "unreachable" | "skipped";
  session?: string;
  reason?: string;
}

/**
 * The subset of AIBroker the bus needs.
 *
 * Deliberately one atomic call rather than liveSessions/launch/send. Deciding
 * "is it running? no — launch it, then send" is session-lifecycle logic, which
 * belongs to whoever owns sessions. Splitting it across a process boundary
 * would duplicate that logic here and race: a session can start or die between
 * the check and the send.
 *
 * Declared as an interface rather than imported so the module carries no hard
 * dependency on AIBroker being installed.
 */
export interface Transport {
  dispatch(
    project: string,
    message: string,
    opts: { spawnIfAbsent: boolean },
  ): Promise<TransportResult>;
}

export interface DispatchOptions {
  transport?: Transport | null;
  /** When false, report ownership without contacting any session. */
  autoDispatch: boolean;
  /** Launch a session when the owner is not running. Default: true. */
  spawnIfAbsent?: boolean;
  /**
   * Reporting only — no session is contacted. Distinguishes "no transport was
   * looked for" from "a transport was looked for and not found", which read
   * identically without it and made a working setup look broken.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/**
 * Render a task as a session-to-session message.
 *
 * The body is included in full and deliberately not summarised: the whole point
 * of the description convention is that a task is actionable months later
 * without re-deriving anything, and truncating it here would undo that.
 */
export function renderTask(task: Task): string {
  const parts = [`Task from the bus: ${task.title}`];
  if (task.due) parts.push(`Due: ${task.due}`);
  if (task.priority !== "p4") parts.push(`Priority: ${task.priority}`);
  if (task.body.trim()) parts.push("", task.body.trim());
  if (task.sourceUrl) parts.push("", `Source: ${task.sourceUrl}`);
  parts.push(
    "",
    `Tracker id: ${task.id}`,
    `When done, run \`pai task done ${task.id}\` so it is not dispatched again.`,
    "No reply is expected — the process that sent this has already exited.",
    "If you are blocked, file it back to the tracker with `pai task add` rather than replying.",
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchTask(
  task: Task,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  if (task.owner.project === null) {
    return {
      task,
      outcome: "unrouted",
      reason: task.owner.rawHint
        ? `"${task.owner.rawHint}" matches no PAI project`
        : "no owner label or container",
    };
  }

  const project = task.owner.project;

  if (!opts.autoDispatch || !opts.transport) {
    // A dry run deliberately passes no transport, so the absence means nothing
    // here — reporting it as "no transport available" made a healthy system
    // look broken, and sent at least one investigation after a fault that did
    // not exist. Routing has already succeeded by this point; say so.
    const reason = opts.dryRun
      ? `would dispatch to ${project} (dry run — no session contacted)`
      : opts.transport
        ? "autoDispatch is off"
        : "no transport available — run `pai <project>` to pick this up";

    return { task, outcome: "skipped", session: project, reason };
  }

  let result: TransportResult;
  try {
    result = await opts.transport.dispatch(project, renderTask(task), {
      spawnIfAbsent: opts.spawnIfAbsent !== false,
    });
  } catch (e) {
    // A transport that throws is an infrastructure failure, not a routing
    // decision — surface it rather than reporting the task as skipped.
    return {
      task,
      outcome: "unlaunchable",
      session: project,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  // Only projects with a curated alias can be launched. That is a setup gap,
  // not a bug — name the fix so it is actionable without digging.
  if (result.outcome === "unlaunchable" && !result.reason?.includes("pai project name")) {
    return {
      task,
      outcome: "unlaunchable",
      session: result.session ?? project,
      reason: `${result.reason ?? "no session could be launched"} — give it an alias with \`pai project name <identifier> ${project}\``,
    };
  }

  return { task, outcome: result.outcome, session: result.session ?? project, reason: result.reason };
}

/**
 * Dispatch a batch, sequentially.
 *
 * Deliberately not parallel: dispatching spawns terminal tabs and types into
 * them. Racing that would interleave input across sessions.
 */
export async function dispatchAll(
  tasks: Task[],
  opts: DispatchOptions,
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  for (const task of tasks) {
    results.push(await dispatchTask(task, opts));
  }
  return results;
}
