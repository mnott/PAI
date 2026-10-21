/**
 * memory-snapshot.ts — one shared, time-bounded snapshot per slow source.
 *
 * The cockpit polls /cockpit/memory every few seconds from several tabs; every
 * poll used to run COUNT(*) on pai_chunks through the shared Postgres pool,
 * so a handful of polls (plus an embed run) held all pool connections and the
 * rest timed out. A Snapshot runs the source at most once per TTL, shares one
 * in-flight call between all callers, and keeps the last good value when a
 * refresh fails, with the failure bookkeeping the display needs.
 */

export interface SnapshotHealth {
  /** consecutive failed refreshes (0 = last refresh succeeded) */
  failures: number;
  /** epoch ms of the first failure of the current streak, null when healthy */
  failingSince: number | null;
  /** error of the latest failed refresh */
  error: string | null;
  /** epoch ms of the last good value, null if never */
  okAt: number | null;
}

export class Snapshot<T> {
  private value: T | null = null;
  private okAt: number | null = null;
  private tryAt = -Infinity;
  private inflight: Promise<void> | null = null;
  private fails = 0;
  private since: number | null = null;
  private err: string | null = null;

  constructor(private fetch: () => Promise<T>, private ttlMs: number, private now: () => number = Date.now) {}

  /** The cached value; refreshes in the background when older than the TTL. Never waits on the source once a value exists. */
  async get(): Promise<T | null> {
    const t = this.now();
    if (t - this.tryAt >= this.ttlMs) this.refresh();
    if (this.value === null && this.inflight) await this.inflight;
    return this.value;
  }

  private refresh(): void {
    if (this.inflight) return;
    this.tryAt = this.now();
    this.inflight = this.fetch().then(
      (v) => { this.value = v; this.okAt = this.now(); this.fails = 0; this.since = null; this.err = null; },
      (e) => {
        this.fails++;
        this.since ??= this.now();
        this.err = e instanceof Error ? e.message : String(e);
      },
    ).finally(() => { this.inflight = null; });
  }

  health(): SnapshotHealth {
    return { failures: this.fails, failingSince: this.since, error: this.err, okAt: this.okAt };
  }
}
