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
