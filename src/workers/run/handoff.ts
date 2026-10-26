/**
 * run/handoff.ts — a local worker still running after workers.localHandoffMinutes active minutes hands its branch to a
 * cloud worker instead of running into max-minutes. The timer is the deadline's (armDeadline: active time, Low Power
 * stretch), set earlier; firing it stops the run like a deadline (so the worktree is salvaged onto the branch) and marks
 * the status `handoffMin`. The restart is the fall-through's (rerunOn), with the original spec behind a header naming the
 * branch.
 */

import { commitLines } from "../worktree.js";
import { appendLedger } from "../ledger.js";
import { saveStatus, type WorkerStatus } from "../status.js";
import type { RunLimit } from "../deadline.js";

/** The handoff threshold as a limit starting at `t0`, or null: off (0), or not before the run's own limit. */
export function handoffLimit(minutes: number, limit: RunLimit | null, t0: number = Date.now()): RunLimit | null {
  if (!(minutes > 0)) return null;
  if (limit && !limit.absolute && limit.minutes <= minutes) return null;
  if (limit?.absolute && limit.deadlineAt <= t0 + minutes * 60_000) return null;
  return { deadlineAt: t0 + minutes * 60_000, minutes };
}

/** The handoff timer fired: record it on the status and in the ledger (the caller then stops the child). */
export function fireHandoff(logDir: string, status: WorkerStatus, ledger: string, minutes: number): void {
  status.timedOut = true;
  status.handoffMin = minutes;
  status.last = `handed off after ${minutes} active min`;
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-HANDOFF", { id: status.id, minutes });
}

/** Fall-through reason of a handed-off run. */
export const handoffReason = (minutes: number): string => `handoff after ${minutes} min`;

/** The spec of the cloud continuation: the header, then the original spec. */
export function handoffSpec(spec: string, id: string, branch: string | undefined, commits: number): string {
  const b = branch ?? `worker/${id}`;
  return `continue from branch ${b}: merge it first, it holds ${commits} commit${commits === 1 ? "" : "s"}; finish, prove, commit.\n\n${spec}`;
}

/** Commit count on the run's branch. */
export function branchCommits(st: Pick<WorkerStatus, "worktreeDir" | "worktreeBase" | "commits">): number {
  return st.worktreeDir && st.worktreeBase ? commitLines(st.worktreeDir, st.worktreeBase).length : (st.commits ?? 0);
}
