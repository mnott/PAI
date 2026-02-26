/**
 * Storage backend factory.
 *
 * Reads the daemon config and returns the appropriate StorageBackend.
 * If Postgres is configured but unavailable, falls back to SQLite with
 * a warning log — the daemon never crashes due to a missing Postgres.
 */

import type { PaiDaemonConfig } from "../daemon/config.js";
import type { StorageBackend } from "./interface.js";

/**
 * Create and return the configured StorageBackend.
 *
 * Auto-fallback behaviour:
 *  - storageBackend = "sqlite"   → SQLiteBackend always
 *  - storageBackend = "postgres" → PostgresBackend if reachable, else SQLiteBackend
 */
export async function createStorageBackend(
  config: PaiDaemonConfig
): Promise<StorageBackend> {
  if (config.storageBackend === "postgres") {
    return await tryPostgres(config);
  }

  // Default: SQLite
  return createSQLiteBackend();
}

async function tryPostgres(config: PaiDaemonConfig): Promise<StorageBackend> {
  try {
    const { PostgresBackend } = await import("./postgres.js");
    const pgConfig = config.postgres ?? {};
    const backend = new PostgresBackend(pgConfig);

    const err = await backend.testConnection();
    if (err) {
      process.stderr.write(
        `[pai-daemon] Postgres unavailable (${err}). Falling back to SQLite.\n`
      );
      await backend.close();
      return createSQLiteBackend();
    }

    process.stderr.write("[pai-daemon] Connected to PostgreSQL backend.\n");
    return backend;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[pai-daemon] Postgres init error (${msg}). Falling back to SQLite.\n`
    );
    return createSQLiteBackend();
  }
}

async function createSQLiteBackend(): Promise<StorageBackend> {
  const { openFederation } = await import("../memory/db.js");
  const { SQLiteBackend } = await import("./sqlite.js");
  const db = openFederation();
  return new SQLiteBackend(db);
}
