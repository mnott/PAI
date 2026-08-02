/**
 * Storage backend factory.
 *
 * Reads the daemon config and returns the appropriate StorageBackend.
 *
 * When Postgres is the configured backend we NEVER silently fall back to
 * SQLite — doing so would split the corpus across two databases. Instead:
 *  - Daemon (waitForPostgres: true) retries Postgres forever with capped
 *    backoff until it comes up (handles the boot race where launchd starts
 *    the daemon before Docker Desktop / Postgres is ready).
 *  - CLI / one-shot callers (default) retry a few times, then throw a clear
 *    error rather than returning a wrong/empty SQLite database.
 */

import type { PaiDaemonConfig } from "../daemon/config.js";
import type { StorageBackend } from "./interface.js";
import { setBackendOutage, clearBackendOutage } from "./outage.js";

export interface StorageBackendOptions {
  /**
   * When true, retry Postgres indefinitely instead of giving up. Used by the
   * long-lived daemon so a not-yet-ready Postgres at boot is tolerated.
   * Defaults to false (one-shot CLI behaviour: bounded retries, then throw).
   */
  waitForPostgres?: boolean;
}

/** Backoff schedule (ms) for the bounded CLI retry path. */
const CLI_RETRY_DELAYS_MS = [500, 1_000, 2_000];

/** Backoff cap (ms) for the daemon's infinite retry path. */
const DAEMON_RETRY_CAP_MS = 15_000;

/**
 * Create and return the configured StorageBackend.
 *
 * Auto-behaviour:
 *  - storageBackend = "sqlite"   → SQLiteBackend always
 *  - storageBackend = "postgres" → PostgresBackend (retried; never falls back)
 */
export async function createStorageBackend(
  config: PaiDaemonConfig,
  opts: StorageBackendOptions = {}
): Promise<StorageBackend> {
  if (config.storageBackend === "postgres") {
    return await connectPostgres(config, opts.waitForPostgres ?? false);
  }

  // Default: SQLite
  return createSQLiteBackend();
}

/**
 * Attempt a single Postgres connection (ensure DB + test). Returns the live
 * backend on success, or an error string describing why it failed.
 */
async function attemptPostgres(
  config: PaiDaemonConfig
): Promise<{ backend: StorageBackend } | { error: string }> {
  const { PostgresBackend } = await import("./postgres.js");
  const pgConfig = config.postgres ?? {};

  let backend: InstanceType<typeof PostgresBackend> | null = null;
  try {
    // Ensure the per-user database exists and has the schema applied.
    await PostgresBackend.ensureDatabase(pgConfig);

    backend = new PostgresBackend(pgConfig);
    const err = await backend.testConnection();
    if (err) {
      await backend.close().catch(() => {});
      return { error: err };
    }
    return { backend };
  } catch (e) {
    if (backend) await backend.close().catch(() => {});
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Consecutive failures before the outage is escalated to the user.
 *
 * Not the first failure: a container restarting, or the daemon starting before
 * Docker is up, recovers within a few seconds and is not worth a notification.
 * By the fifth attempt the backoff has already spent tens of seconds, which is
 * long enough that something is actually wrong.
 */
const ESCALATE_AFTER_ATTEMPTS = 5;

/** Tell the user the backend is down, through whatever channels are configured. */
async function notifyBackendDown(attempts: number, lastError: string): Promise<void> {
  try {
    const { routeNotification } = await import("../notifications/router.js");
    const { loadConfig } = await import("../daemon/config.js");
    await routeNotification(
      {
        event: "error",
        title: "PAI: storage backend unreachable",
        message:
          `Postgres has not answered in ${attempts} attempts (${lastError}). ` +
          `Indexing, session notes and the work queue are stalled until it returns. ` +
          `Check the container, then \`pai daemon status\`.`,
      },
      loadConfig().notifications
    );
  } catch {
    // A notification that cannot be sent must never take the daemon down with
    // it — the daemon retrying is still the useful behaviour here.
  }
}

/** And say when it comes back, so the alert is not left hanging. */
async function notifyBackendRecovered(
  attempts: number,
  since: number | null
): Promise<void> {
  try {
    const { routeNotification } = await import("../notifications/router.js");
    const { loadConfig } = await import("../daemon/config.js");
    const mins = since ? Math.max(1, Math.round((Date.now() - since) / 60_000)) : null;
    await routeNotification(
      {
        event: "completion",
        title: "PAI: storage backend back",
        message:
          `Postgres answered after ${attempts} attempts` +
          (mins ? `, ${mins} min down` : "") +
          `. The queue will drain on its own.`,
      },
      loadConfig().notifications
    );
  } catch {
    /* same reasoning as above */
  }
}

async function connectPostgres(
  config: PaiDaemonConfig,
  waitForever: boolean
): Promise<StorageBackend> {
  let attempt = 0;
  let lastError = "unknown error";
  let outageSince: number | null = null;
  let escalated = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const result = await attemptPostgres(config);
    if ("backend" in result) {
      if (attempt > 1) {
        process.stderr.write(
          `[pai-daemon] Connected to PostgreSQL backend (after ${attempt} attempts).\n`
        );
      } else {
        process.stderr.write("[pai-daemon] Connected to PostgreSQL backend.\n");
      }
      // An outage that ended must stop being reported, or the status command
      // trades one wrong answer for another.
      clearBackendOutage();
      if (escalated) void notifyBackendRecovered(attempt, outageSince);
      return result.backend;
    }

    lastError = result.error;

    if (!waitForever && attempt > CLI_RETRY_DELAYS_MS.length) {
      // Bounded CLI path exhausted — fail loudly, never silently use SQLite.
      throw new Error(
        `Postgres backend unreachable after ${attempt} attempts: ${lastError}. ` +
          `Is Docker Desktop / Postgres running? Refusing to fall back to SQLite ` +
          `(would split the corpus). Start Postgres and retry.`
      );
    }

    const delayMs = waitForever
      ? Math.min(DAEMON_RETRY_CAP_MS, 1_000 * 2 ** Math.min(attempt - 1, 4))
      : CLI_RETRY_DELAYS_MS[attempt - 1];

    process.stderr.write(
      `[pai-daemon] Postgres unavailable (${lastError}). ` +
        `Retry ${attempt}${waitForever ? "" : `/${CLI_RETRY_DELAYS_MS.length + 1}`} ` +
        `in ${delayMs}ms...\n`
    );

    // Publish the outage so `pai daemon status` can report it. Without this the
    // daemon retries silently forever and status still reads "idle" — which is
    // what happened for two days in July: 144 retries over 36 minutes, session
    // notes never written, and the one command anyone would run to check
    // reporting that everything was fine.
    setBackendOutage({
      backend: "postgres",
      since: outageSince ?? (outageSince = Date.now()),
      attempts: attempt,
      lastError: String(lastError),
    });

    // And escalate once, out loud, rather than only into a log nobody tails.
    // Once — not per retry — because a notification that repeats every few
    // seconds is filtered within a minute and stops being a signal at all.
    if (waitForever && attempt === ESCALATE_AFTER_ATTEMPTS && !escalated) {
      escalated = true;
      void notifyBackendDown(attempt, String(lastError));
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }
}

async function createSQLiteBackend(): Promise<StorageBackend> {
  const { openFederation } = await import("../memory/db.js");
  const { SQLiteBackend } = await import("./sqlite.js");
  const db = openFederation();
  return new SQLiteBackend(db);
}
