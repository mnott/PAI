/**
 * Raw SQL introspection for `pai db query|tables|schema` — the one place
 * outside the backend classes themselves allowed to reach for the
 * underlying engine handle, so cli/commands/db.ts never has to import
 * better-sqlite3/pg or open its own connection (it goes through the
 * process-wide backend from storage/factory.ts instead).
 */

import type { StorageBackend } from "./interface.js";
import type { SQLiteBackend } from "./sqlite.js";
import type { PostgresBackend } from "./postgres.js";
import { createPgPool } from "./pg-pool.js";

export interface TableResult {
  columns: string[];
  rows: unknown[][];
}

function asSqlite(backend: StorageBackend): SQLiteBackend {
  return backend as unknown as SQLiteBackend;
}

function asPostgresPool(backend: StorageBackend) {
  return (backend as unknown as PostgresBackend).getPool();
}

export async function runDbQuery(backend: StorageBackend, sql: string): Promise<TableResult> {
  if (backend.backendType === "postgres") {
    const result = await asPostgresPool(backend).query(sql);
    const columns = result.fields.map((f) => f.name);
    const rows = result.rows.map((r: Record<string, unknown>) => columns.map((c) => r[c]));
    return { columns, rows };
  }
  const db = asSqlite(backend).getRawDb();
  const stmt = db.prepare(sql);
  const raw = stmt.all() as Record<string, unknown>[];
  if (raw.length === 0) return { columns: [], rows: [] };
  const columns = Object.keys(raw[0]);
  const rows = raw.map((r) => columns.map((c) => r[c]));
  return { columns, rows };
}

export async function listDbTables(backend: StorageBackend): Promise<string[]> {
  if (backend.backendType === "postgres") {
    const result = await asPostgresPool(backend).query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    return result.rows.map((r) => r.tablename);
  }
  const db = asSqlite(backend).getRawDb();
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export async function getDbTableSchema(backend: StorageBackend, table: string): Promise<TableResult> {
  if (backend.backendType === "postgres") {
    const result = await asPostgresPool(backend).query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    if (result.rows.length === 0) {
      throw new Error(`Table not found in public schema: ${table}`);
    }
    const columns = ["column", "type", "nullable", "default"];
    const rows = result.rows.map((r) => [
      r.column_name,
      r.data_type,
      r.is_nullable === "YES" ? "YES" : "NO",
      r.column_default ?? "",
    ]);
    return { columns, rows };
  }

  const db = asSqlite(backend).getRawDb();
  // Validate table name — only allow alphanumeric / underscores
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }

  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  if (rows.length === 0) {
    throw new Error(`Table not found: ${table}`);
  }
  const columns = ["cid", "name", "type", "notnull", "default", "pk"];
  const outRows = rows.map((r) => [
    r.cid,
    r.name,
    r.type,
    r.notnull ? "NOT NULL" : "",
    r.dflt_value ?? "",
    r.pk ? "PK" : "",
  ]);
  return { columns, rows: outRows };
}

/** The scratch-database name pattern tests create (src/storage/test-db.ts). */
export const TEST_DB_PATTERN = "^pai_test_[a-z0-9_]+$";

/** Age after which a pai_test_* database is considered leaked, not in-flight. */
export const TEST_DB_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Drop leaked scratch test databases: names matching pai_test_* whose creation
 * is older than minAgeMs. pg_database has no timestamp, so age comes from the
 * oldest relation in each database (pg_stat_file on its base directory — the
 * same trick PG 17's AGE clauses use). A freshly created database (still being
 * used by a running test) is never touched; a database with no relations yet
 * reports NULL age and is skipped. Nothing outside the pattern is dropped, and
 * createPgPool's live-database guard still applies underneath.
 *
 * `onlyNames` narrows the sweep to an explicit list — a test that wants to
 * prove its own drop must pass exactly the databases it created. An exclusion
 * list is not enough: ownership is per-process (test-db.ts), so a sweep in one
 * vitest worker can still drop another worker's in-flight scratch database,
 * and the age heuristic does not protect it either — a freshly CREATEd
 * database's file timestamp is copied from its template and can read hours
 * old. That was the merge-gate flaky "database pai_test_… does not exist"
 * (codegraph NUL test), fixed 2026-11-19. The default (no filter, minAgeMs 1h)
 * stays the leak sweep for real use.
 *
 * A database any backend is still connected to is never dropped either:
 * `DROP DATABASE` terminates other clients' connections ("Connection
 * terminated unexpectedly"), which is how a release run lost a scratch
 * database another vitest worker was mid-use (2026-11-24, runs 1 and 2). The
 * age heuristic cannot cover that — the template's mtime is copied on CREATE,
 * so a fresh scratch db can read months old — so an open backend connection
 * is checked before every drop.
 */
export async function cleanupTestDatabases(
  adminConnectionString: string,
  opts: { minAgeMs?: number; dryRun?: boolean; onlyNames?: readonly string[] } = {},
): Promise<string[]> {
  const minAgeMs = opts.minAgeMs ?? TEST_DB_MIN_AGE_MS;
  const only = opts.onlyNames ? [...opts.onlyNames] : null;
  const admin = createPgPool({ connectionString: adminConnectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const found = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
       WHERE d.datistemplate = false
         AND d.datname ~ $1
         AND ($3::text[] IS NULL OR d.datname = ANY($3))
         AND age(now(), (pg_stat_file(format('%s/base/%s', current_setting('data_directory'), d.oid), true)).modification)
             > make_interval(secs => $2::double precision / 1000)
         -- a backend still connected means a live test is mid-use: dropping
         -- would terminate its connections ("Connection terminated
         -- unexpectedly"), the release-run flaky of 2026-11-24.
         AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)
       ORDER BY d.datname`,
      [TEST_DB_PATTERN, minAgeMs, only],
    );
    const dropped: string[] = [];
    for (const { datname } of found.rows) {
      if (opts.dryRun) { dropped.push(datname); continue; }
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${datname.replace(/"/g, '""')}"`);
        dropped.push(datname);
      } catch {
        // a test still connected to it: leave it for the next run
      }
    }
    return dropped;
  } finally {
    await admin.end();
  }
}

/** Admin URL ('postgres' database) derived from a configured connection string. */
export function pgAdminUrl(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}
