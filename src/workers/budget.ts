/**
 * budget.ts — the progress-based time budget of a run. A worker starts with a
 * short allowance (workers.timeBudget.start, 20 min of own time — active time
 * minus time in line at the model, as the stall clock computes it). At the end
 * of each allowance an automatic checkpoint runs without a model call: progress
 * is new edits or commits since the last checkpoint, new successful test runs,
 * or (read-only jobs) new successful tool calls. With progress the allowance
 * doubles (20 → 40 → 80), capped at workers.timeBudget.cap and the run's own
 * max-minutes, and the job keeps running untouched; the extension is logged.
 * Without progress the run is stopped with its work saved on its branch (the
 * existing salvage), marked "needs review", and one mailbox line goes to the
 * owning session — never an automatic fall-through to the cloud from here.
 */

import { appendLedger } from "./ledger.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";
import type { RunLimit } from "./deadline.js";
import { parseDuration } from "./policy.js";

/** workers.timeBudget: the opening allowance, the doubling factor, the ceiling. */
export interface TimeBudgetConfig {
  start: number;
  factor: number;
  cap: number;
}

export const DEFAULT_TIME_BUDGET: TimeBudgetConfig = { start: 20, factor: 2, cap: 120 };

/** What a checkpoint measures: the run's own counters and branch commit count. */
export interface BudgetSnapshot {
  /** Successful edit/write/commit tool calls (status.progressAt set by them). */
  progressAtMs: number;
  /** Successful test runs since the last checkpoint. */
  testsPassed: number;
  /** Successful tool calls since the last checkpoint (a read-only job's progress). */
  toolsOk: number;
  /** Commits on the run's branch. */
  commits: number;
}

export const emptySnapshot = (): BudgetSnapshot => ({ progressAtMs: 0, testsPassed: 0, toolsOk: 0, commits: 0 });

/** What changed between two snapshots, in words; null when nothing did. */
export function budgetProgress(prev: BudgetSnapshot, cur: BudgetSnapshot, readOnly = false): string | null {
  const parts: string[] = [];
  if (cur.commits > prev.commits) parts.push(`${cur.commits - prev.commits} commit${cur.commits - prev.commits === 1 ? "" : "s"}`);
  else if (cur.progressAtMs > prev.progressAtMs) parts.push("new edits");
  if (cur.testsPassed > prev.testsPassed) parts.push("tests ran");
  if (readOnly && cur.toolsOk > prev.toolsOk) parts.push(`${cur.toolsOk - prev.toolsOk} successful tool call${cur.toolsOk - prev.toolsOk === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : null;
}

/** The opening allowance in minutes: the config start, never past the run's own limit or the cap. */
export function initialBudgetMinutes(cfg: TimeBudgetConfig, maxMinutes?: number | null): number {
  const cap = Math.min(cfg.cap, DEFAULT_TIME_BUDGET.cap);
  let m = Math.min(Math.max(1, cfg.start), cap);
  if (maxMinutes && maxMinutes > 0) m = Math.min(m, maxMinutes);
  return m;
}

/** The allowance after one checkpoint: doubled toward the cap, or null when it cannot grow further. */
export function nextBudgetMinutes(cur: number, cfg: TimeBudgetConfig, maxMinutes?: number | null): number | null {
  const cap = Math.min(cfg.cap, DEFAULT_TIME_BUDGET.cap);
  const ceiling = maxMinutes && maxMinutes > 0 ? Math.min(cap, maxMinutes) : cap;
  if (cur >= ceiling) return null;
  const grown = cur * Math.max(1.001, cfg.factor);
  return Math.max(cur + 1, Math.min(Math.round(grown), ceiling));
}

/** The budget limit as a RunLimit starting at `t0`: armDeadline counts active time and stretches it in Low Power like any minutes-based limit. */
export function budgetLimit(minutes: number, t0: number = Date.now()): RunLimit {
  return { deadlineAt: t0 + minutes * 60_000, minutes };
}

/** One checkpoint's decision for the timer: extend with the doubled allowance, or stop for review. */
export function budgetCheck(
  prev: BudgetSnapshot,
  cur: BudgetSnapshot,
  o: { readOnly?: boolean; minutes: number; cfg: TimeBudgetConfig; maxMinutes?: number | null }
): { action: "extend"; minutes: number; why: string } | { action: "review"; why: string } {
  const progress = budgetProgress(prev, cur, o.readOnly === true);
  if (progress) {
    const next = nextBudgetMinutes(o.minutes, o.cfg, o.maxMinutes);
    if (next !== null) return { action: "extend", minutes: next, why: `extended to ${next} min: ${progress}` };
  }
  return { action: "review", why: progress ? `out of time at the ${o.minutes}-min cap: ${progress}` : `no progress in its ${o.minutes}-min allowance` };
}

/** The ps/cockpit time-column tooltip: "budget 40m (extended 1x)". */
export function budgetText(s: Pick<WorkerStatus, "budgetMin" | "budgetExtensions">): string | null {
  if (!s.budgetMin) return null;
  const x = s.budgetExtensions ?? 0;
  return `budget ${s.budgetMin}m${x > 0 ? ` (extended ${x}x)` : ""}`;
}

/** The mailbox line of a needs-review stop: id, what it did, the last error, and the three ways on. */
export function reviewNote(id: string, label: string, why: string, did: string[], lastError?: string | null): string {
  const lines = [`[pai worker] ${id} (${label}) stopped for review: ${why}.`];
  if (did.length) lines.push(`Did: ${did.join("; ")}`);
  if (lastError) lines.push(`Last error: ${lastError}`);
  lines.push(
    `Work is saved on its branch. The session decides: resume locally with a note (\`pai worker resume ${id} '<note>'\`), give more time (\`pai worker extend ${id} 30m\`), or ask the gatekeeper for the cloud.`
  );
  return lines.join("\n");
}

/** `pai worker extend <id> 30m`: the new ceiling in minutes past the run's start; null when the duration is malformed. */
export function parseExtendMinutes(s: string): number | null {
  try {
    const ms = parseDuration(s.trim());
    return Math.max(1, Math.round(ms / 60_000));
  } catch {
    return null;
  }
}

/**
 * The budget timer fired at the end of an allowance: record the checkpoint's
 * outcome on the status and in the ledger (the caller re-arms or stops).
 */
export function fireBudget(
  logDir: string,
  status: WorkerStatus,
  ledger: string,
  o: { action: "extend" | "review"; minutes: number; why: string }
): void {
  if (o.action === "extend") {
    status.budgetMin = o.minutes;
    status.budgetExtensions = (status.budgetExtensions ?? 0) + 1;
    saveBudgetDeadline(logDir, status);
    appendLedger(ledger, "WORKER-BUDGET-EXTEND", { id: status.id, minutes: o.minutes, why: o.why });
    return;
  }
  status.needsReview = true;
  status.last = o.why;
  saveBudgetDeadline(logDir, status);
  appendLedger(ledger, "WORKER-BUDGET-REVIEW", { id: status.id, minutes: o.minutes, why: o.why });
}

/** Keep the status' deadlineAt in step with the current budget allowance, so ps shows the real time left. */
function saveBudgetDeadline(logDir: string, status: WorkerStatus): void {
  const started = Date.parse(status.started.replace(" ", "T"));
  if (status.budgetMin && Number.isFinite(started)) status.deadlineAt = started + status.budgetMin * 60_000;
  status.updated = nowStamp();
}
