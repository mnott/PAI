/**
 * Scratch Postgres databases for tests — the one place a test creates one.
 *
 * A scratch database is named pai_test_<purpose>_<random>, created on the
 * server the config names and dropped in `after()` (plus a process-exit hook,
 * so an interrupted run does not leave it behind). Before this helper existed
 * every pg-backed test rolled its own CREATE DATABASE and most cleaned up only
 * inside the happy path: the container accumulated hundreds of leftovers
 * (pai_test_hooksdb_*, pai_test_registry_*, …), reported 2026-11-18.
 *
 * A scratch name is never the live database: test/setup-home-guard.ts exports
 * PAI_TEST_LIVE_DB and createPgPool refuses to connect to it, so a scratch URL
 * derived from the configured connection string always differs. `pai db
 * cleanup-test-dbs` drops leftovers older than an hour that survived anyway.
 */

import pg from "pg";
import { loadConfig } from "../daemon/config.js";
import { createPgPool } from "./pg-pool.js";

const { Pool } = pg;

/** Admin connection: the configured server, always the 'postgres' database. */
function adminUrl(): string {
  const base = loadConfig().postgres?.connectionString;
  if (!base) throw new Error("postgres.connectionString not configured — cannot create a scratch database");
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return admin.toString();
}

async function dropDatabase(dbName: string): Promise<void> {
  const admin = createPgPool({ connectionString: adminUrl(), max: 1, connectionTimeoutMillis: 5000 });
  try {
    // active test connections must be gone before the drop lands; retry a few times
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${pgquote(dbName)}`);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/other users are connected/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } finally {
    await admin.end();
  }
}

/** Double-quoted identifier (same rule as storage/postgres/config.ts quoteIdent). */
function pgquote(name: string): string {
  if (name === "" || name.includes("\0")) throw new Error(`invalid Postgres identifier ${JSON.stringify(name)}`);
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ScratchDb {
  dbName: string;
  /** Connection URL of the scratch database. */
  url: string;
  /** A pool over it (createPgPool: live-database guard applies). */
  pool: pg.Pool;
  /** End the pool and drop the database. Idempotent; safe in after()/afterAll(). */
  cleanup: () => Promise<void>;
}

const openScratch = new Map<string, ScratchDb>();

/**
 * Create `pai_test_<purpose>_<random>` on the configured server and hand back a
 * pool plus a cleanup. Call cleanup from after()/afterAll(); a process-exit
 * hook drops it too if the run is interrupted before cleanup runs.
 */
export async function createScratchDatabase(purpose: string): Promise<ScratchDb> {
  const dbName = `pai_test_${purpose}_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(adminUrl());
  scratch.pathname = `/${dbName}`;
  const url = scratch.toString();

  const admin = createPgPool({ connectionString: adminUrl(), max: 1, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE DATABASE ${pgquote(dbName)}`);
  } finally {
    await admin.end();
  }

  const pool = createPgPool({ connectionString: url, max: 1, connectionTimeoutMillis: 8000 });
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    openScratch.delete(dbName);
    try { await pool.end(); } catch { /* already ended */ }
    await dropDatabase(dbName);
  };
  const scratchDb: ScratchDb = { dbName, url, pool, cleanup };
  openScratch.set(dbName, scratchDb);
  return scratchDb;
}

// safety net: a run that exits without running afterAll still drops its dbs.
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const dropAllSyncish = (): void => {
    for (const db of [...openScratch.values()]) {
      // fire-and-forget is all an exit hook can do; the CLI cleanup verb is
      // the durable backstop for what this misses.
      void db.cleanup().catch(() => { /* best effort */ });
    }
  };
  process.once("exit", dropAllSyncish);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      dropAllSyncish();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}
installExitHook();
