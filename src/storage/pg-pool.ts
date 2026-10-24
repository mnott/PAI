/**
 * The one place a Postgres Pool is constructed.
 *
 * Under test, test/setup-home-guard.ts exports the live database name as
 * PAI_TEST_LIVE_DB. A connection to that database is refused here, so no test
 * (and no `pai` child a test spawns) can write to the real corpus: the
 * 2026-10-24 01:48 UTC `projects` wipe came from a test run that reached the
 * live Postgres through the operator's config. Scratch databases created by
 * the test helpers (pai_test_*) are different names and pass.
 * Outside tests the variable is unset and this is a plain `new Pool`.
 */

import pg from "pg";
import { noteForeignConfigLiveDb } from "./foreign-config-guard.js";

export function assertNotLiveDatabase(connectionString: string | undefined): void {
  const live = process.env.PAI_TEST_LIVE_DB;
  if (!live || !connectionString) return;
  let db: string;
  try {
    db = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  } catch {
    return;
  }
  if (db === live) throw new Error("test tried to open the live database");
}

export function createPgPool(opts: pg.PoolConfig): pg.Pool {
  assertNotLiveDatabase(opts.connectionString);
  noteForeignConfigLiveDb();
  return new pg.Pool(opts);
}
