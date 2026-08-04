/**
 * daemon-status.ts — the health part of `pai daemon status`, as data.
 *
 * The daemon has always sent its work-queue depth in the status payload and the
 * command has never printed it. That is the remaining half of the July finding:
 * the queue backing up is what an outage actually looks like from outside —
 * `session-end`, `session-summary` and `registry-scan` enqueued and never
 * drained, session notes for two days never written — and it was the one number
 * that would have said so.
 *
 * Kept separate from the printing, and pure, because "does status report the
 * outage" is exactly the assertion that was missing when status reported
 * "Index: idle" through a two-day outage. A function that only writes to stdout
 * cannot be asked that question.
 */

import type { BackendOutage } from "../../storage/outage.js";
import { humanDuration } from "../../storage/outage.js";

export type HealthSeverity = "error" | "warn" | "info";

export interface HealthLine {
  severity: HealthSeverity;
  text: string;
}

/** The subset of the daemon status payload that describes storage health. */
export interface StorageHealthStatus {
  backendOutage?: BackendOutage | null;
  workQueue?: {
    pending?: number;
    processing?: number;
    completed?: number;
    failed?: number;
    total?: number;
  } | null;
}

/**
 * Health lines to print above the index/DB figures, worst first.
 *
 * Empty when there is nothing wrong: a healthy daemon should not grow a
 * paragraph of reassurance, or the one time it says something real gets read as
 * more of the same.
 */
export function formatStorageHealth(
  s: StorageHealthStatus,
  now = Date.now()
): HealthLine[] {
  const lines: HealthLine[] = [];
  const outage = s.backendOutage ?? null;

  if (outage) {
    lines.push({
      severity: "error",
      text: `BACKEND DOWN: ${outage.backend} unreachable for ${humanDuration(now - outage.since)}`,
    });
    lines.push({
      severity: "warn",
      text: `${outage.attempts} attempts — ${outage.lastError}`,
    });
  }

  const queue = queueLine(s.workQueue, outage !== null);
  if (queue) lines.push(queue);

  if (outage) {
    lines.push({
      severity: "info",
      text: "Indexing, session notes and the work queue are stalled until it returns.",
    });
  }

  return lines;
}

/**
 * The queue depth, when it means something.
 *
 * During an outage it always means something — including a depth of zero, which
 * says the backlog is not the reason nothing is happening. Otherwise it is only
 * worth a line when work is actually sitting there: a queue that is empty
 * because everything drained is the normal case, and printing it every time
 * teaches the reader to skip the line.
 *
 * `failed` is reported whenever it is non-zero, outage or not. Items that
 * exhausted their retries are the silent-loss case this whole status block
 * exists for — they will never be retried and nothing else surfaces them.
 */
function queueLine(
  q: StorageHealthStatus["workQueue"],
  duringOutage: boolean
): HealthLine | null {
  if (!q) return null;

  const pending = q.pending ?? 0;
  const processing = q.processing ?? 0;
  const failed = q.failed ?? 0;
  const waiting = pending + processing;

  if (!duringOutage && waiting === 0 && failed === 0) return null;

  const parts = [`${pending} pending`];
  if (processing > 0) parts.push(`${processing} processing`);
  if (failed > 0) parts.push(`${failed} failed`);

  return {
    // A backlog while the backend is down is a symptom, not a fault of its own;
    // failures that will never retry are a fault whether or not anything is down.
    severity: failed > 0 ? "error" : duringOutage || waiting > 0 ? "warn" : "info",
    text: `Work queue:  ${parts.join(", ")}`,
  };
}
