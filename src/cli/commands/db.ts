/**
 * pai db <sub-command>
 *
 * Quick database inspection commands for both SQLite and Postgres backends.
 *
 *   pai db query  <sql>   [--db sqlite|postgres]  [--json]
 *   pai db tables         [--db sqlite|postgres]
 *   pai db schema <table> [--db sqlite|postgres]
 */

import type { Command } from "commander";
import { ok, warn, err, dim, bold, header, renderTable } from "../utils.js";
import { loadConfig } from "../../daemon/config.js";
import { openFederation } from "../../memory/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DbTarget = "sqlite" | "postgres";

interface CommonOpts {
  db?: DbTarget;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// SQLite helpers (synchronous — better-sqlite3)
// ---------------------------------------------------------------------------

function getSqliteDb() {
  return openFederation();
}

function sqliteQuery(sql: string): { columns: string[]; rows: unknown[][] } {
  const db = getSqliteDb();
  try {
    const stmt = db.prepare(sql);
    const raw = stmt.all() as Record<string, unknown>[];
    if (raw.length === 0) return { columns: [], rows: [] };
    const columns = Object.keys(raw[0]);
    const rows = raw.map((r) => columns.map((c) => r[c]));
    return { columns, rows };
  } finally {
    db.close();
  }
}

function sqliteTables(): string[] {
  const db = getSqliteDb();
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

function sqliteSchema(table: string): { columns: string[]; rows: unknown[][] } {
  const db = getSqliteDb();
  try {
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
    const data = rows.map((r) => [
      r.cid,
      r.name,
      r.type,
      r.notnull ? "NOT NULL" : "",
      r.dflt_value ?? "",
      r.pk ? "PK" : "",
    ]);
    return { columns, data: data } as unknown as { columns: string[]; rows: unknown[][] };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Postgres helpers (async — pg Pool)
// ---------------------------------------------------------------------------

async function getPool() {
  const config = loadConfig();
  const pgConfig = config.postgres ?? {};

  const { Pool } = await import("pg");

  // Build connection params from config
  const poolConfig = pgConfig.connectionString
    ? { connectionString: pgConfig.connectionString }
    : {
        host: pgConfig.host ?? "localhost",
        port: pgConfig.port ?? 5432,
        database: pgConfig.database ?? "pai",
        user: pgConfig.user ?? "pai",
        password: pgConfig.password ?? "pai",
        connectionTimeoutMillis: pgConfig.connectionTimeoutMs ?? 5000,
      };

  const pool = new Pool(poolConfig);

  // Quick connectivity test
  try {
    const client = await pool.connect();
    client.release();
  } catch (e) {
    await pool.end();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot connect to Postgres: ${msg}`);
  }

  return pool;
}

async function postgresQuery(
  sql: string
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const pool = await getPool();
  try {
    const result = await pool.query(sql);
    const columns = result.fields.map((f) => f.name);
    const rows = result.rows.map((r: Record<string, unknown>) =>
      columns.map((c) => r[c])
    );
    return { columns, rows };
  } finally {
    await pool.end();
  }
}

async function postgresTables(): Promise<string[]> {
  const pool = await getPool();
  try {
    const result = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    return result.rows.map((r) => r.tablename);
  } finally {
    await pool.end();
  }
}

async function postgresSchema(
  table: string
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const pool = await getPool();
  try {
    const result = await pool.query<{
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
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printResult(
  result: { columns: string[]; rows: unknown[][] },
  json: boolean
): void {
  if (json) {
    const objects = result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });
    console.log(JSON.stringify(objects, null, 2));
    return;
  }

  if (result.rows.length === 0) {
    console.log();
    console.log(dim("  (no rows)"));
    console.log();
    return;
  }

  const stringRows = result.rows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return dim("NULL");
      if (typeof cell === "object") return JSON.stringify(cell);
      return String(cell);
    })
  );

  console.log();
  console.log(renderTable(result.columns, stringRows));
  console.log();
  console.log(dim(`  ${result.rows.length} row(s)`));
  console.log();
}

// ---------------------------------------------------------------------------
// pai db query
// ---------------------------------------------------------------------------

async function cmdQuery(
  sql: string,
  opts: CommonOpts
): Promise<void> {
  const target: DbTarget = opts.db ?? "sqlite";
  console.log();
  console.log(
    header(`  Query [${target}]`) + dim(`  ${sql.slice(0, 80)}${sql.length > 80 ? "…" : ""}`)
  );

  try {
    let result: { columns: string[]; rows: unknown[][] };
    if (target === "postgres") {
      result = await postgresQuery(sql);
    } else {
      result = sqliteQuery(sql);
    }
    printResult(result, opts.json ?? false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  ${msg}`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// pai db tables
// ---------------------------------------------------------------------------

async function cmdTables(opts: CommonOpts): Promise<void> {
  const target: DbTarget = opts.db ?? "sqlite";
  console.log();
  console.log(header(`  Tables [${target}]`));
  console.log();

  try {
    let tables: string[];
    if (target === "postgres") {
      tables = await postgresTables();
    } else {
      tables = sqliteTables();
    }

    if (opts.json) {
      console.log(JSON.stringify(tables, null, 2));
      return;
    }

    if (tables.length === 0) {
      console.log(dim("  (no tables found)"));
    } else {
      for (const t of tables) {
        console.log(`  ${bold(t)}`);
      }
    }
    console.log();
    console.log(dim(`  ${tables.length} table(s)`));
    console.log();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  ${msg}`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// pai db schema
// ---------------------------------------------------------------------------

async function cmdSchema(table: string, opts: CommonOpts): Promise<void> {
  const target: DbTarget = opts.db ?? "sqlite";
  console.log();
  console.log(header(`  Schema: ${table} [${target}]`));

  try {
    let result: { columns: string[]; rows: unknown[][] };
    if (target === "postgres") {
      result = await postgresSchema(table);
    } else {
      const raw = sqliteSchema(table) as unknown as {
        columns: string[];
        data: unknown[][];
      };
      result = { columns: raw.columns, rows: raw.data };
    }
    printResult(result, opts.json ?? false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  ${msg}`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerDbCommands(dbCmd: Command): void {
  dbCmd
    .command("query <sql>")
    .description("Run a SQL query against the selected database")
    .option("--db <target>", "Database target: sqlite (default) or postgres", "sqlite")
    .option("--json", "Output results as JSON array")
    .action(async (sql: string, opts: CommonOpts) => {
      await cmdQuery(sql, opts);
    });

  dbCmd
    .command("tables")
    .description("List all tables in the selected database")
    .option("--db <target>", "Database target: sqlite (default) or postgres", "sqlite")
    .option("--json", "Output as JSON array")
    .action(async (opts: CommonOpts) => {
      await cmdTables(opts);
    });

  dbCmd
    .command("schema <table>")
    .description("Show column schema for a table")
    .option("--db <target>", "Database target: sqlite (default) or postgres", "sqlite")
    .option("--json", "Output as JSON array")
    .action(async (table: string, opts: CommonOpts) => {
      await cmdSchema(table, opts);
    });
}
