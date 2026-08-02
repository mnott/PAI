/**
 * outage.ts — is the storage backend actually reachable right now?
 *
 * The daemon retries a dead backend forever, which is correct: a Postgres
 * container that is down will usually come back, and giving up would lose the
 * work queue. What was wrong is that it did so in complete silence.
 *
 * Observed 2026-07-26: the container was down for roughly two days. The daemon
 * logged "Postgres unavailable" 144 times over 36 minutes, the work queue backed
 * up, session notes for the whole period were never written — and
 * `pai daemon status` reported "Index: idle" throughout. The one command anyone
 * would run to check said everything was fine.
 *
 * So the outage is recorded where the status command can see it, and escalated
 * once through the notification channels that were already configured and
 * already unused for this.
 */

export interface BackendOutage {
  backend: string;
  /** When the current run of failures began. */
  since: number;
  /** Consecutive failed attempts so far. */
  attempts: number;
  lastError: string;
}

let current: BackendOutage | null = null;

/** Record that the backend is currently unreachable. */
export function setBackendOutage(outage: BackendOutage): void {
  current = outage;
}

/**
 * Record that the backend answered.
 *
 * Called on every successful connection, including the first — so a daemon that
 * never had a problem reports none, and one that recovered stops reporting an
 * outage that has ended.
 */
export function clearBackendOutage(): void {
  current = null;
}

/** The current outage, or null when the backend is answering. */
export function getBackendOutage(): BackendOutage | null {
  return current;
}

/** Human-readable duration, for a status line rather than a log. */
export function describeOutage(o: BackendOutage, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - o.since) / 60_000));
  const forHow = mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`;
  return `${o.backend} unreachable for ${forHow}, ${o.attempts} attempts — ${o.lastError}`;
}
