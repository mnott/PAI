/**
 * pai db <sub-command>
 *
 * Quick database inspection commands for both SQLite and Postgres backends.
 *
 *   pai db query  <sql>   [--db sqlite|postgres]  [--json]
 *   pai db tables         [--db sqlite|postgres]
 *   pai db schema <table> [--db sqlite|postgres]
 */

import { ok, warn, err, dim, bold, header, renderTable } from "../lib/utils.js";
import { loadConfig } from "../../daemon/config.js";
import { migrateToPostgres, renderReport } from "../../storage/migrate-to-postgres.js";
import { createStorageBackend } from "../../storage/factory.js";
import { runDbQuery, listDbTables, getDbTableSchema } from "../../storage/db-admin.js";
import type { StorageBackend } from "../../storage/interface.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DbTarget = "sqlite" | "postgres";

interface CommonOpts {
  db?: DbTarget;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Backend-agnostic helpers — a one-off backend for the requested target
// (independent of the process's configured backend, since this tool is for
// inspecting either engine), created via storage/factory.ts's single entry
// point so this file never opens its own better-sqlite3/pg connection.
// ---------------------------------------------------------------------------

async function backendForTarget(target: DbTarget): Promise<StorageBackend> {
  const config = loadConfig();
  return createStorageBackend({ ...config, storageBackend: target });
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

export async function cmdQuery(
  sql: string,
  opts: CommonOpts
): Promise<number> {
  const target: DbTarget = opts.db ?? "sqlite";
  console.log();
  console.log(
    header(`  Query [${target}]`) + dim(`  ${sql.slice(0, 80)}${sql.length > 80 ? "…" : ""}`)
  );

  try {
    let result: { columns: string[]; rows: unknown[][] };
    const backend = await backendForTarget(target);
    try {
      result = await runDbQuery(backend, sql);
    } finally {
      await backend.close();
    }
    printResult(result, opts.json ?? false);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  ${msg}`));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// pai db tables
// ---------------------------------------------------------------------------

export async function cmdTables(opts: CommonOpts): Promise<number> {
  const target: DbTarget = opts.db ?? "sqlite";
  console.log();
  console.log(header(`  Tables [${target}]`));
  console.log();

  try {
    let tables: string[];
    const backend = await backendForTarget(target);
    try {
      tables = await listDbTables(backend);
    } finally {
      await backend.close();
    }

    if (opts.json) {
      console.log(JSON.stringify(tables, null, 2));
      return 0;
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
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  ${msg}`));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// pai db schema
// ---------------------------------------------------------------------------

export async function cmdSchema(table: string, opts: CommonOpts): Promise<number> {
  const target: DbTarget = opts.db ?? "sqlite";
  console.log();
  console.log(header(`  Schema: ${table} [${target}]`));

  try {
    let result: { columns: string[]; rows: unknown[][] };
    const backend = await backendForTarget(target);
    try {
      result = await getDbTableSchema(backend, table);
    } finally {
      await backend.close();
    }
    printResult(result, opts.json ?? false);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  ${msg}`));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// pai db migrate-to-postgres
// ---------------------------------------------------------------------------

export async function cmdMigrateToPostgres(opts: { dryRun?: boolean; skipDump?: boolean; allowRunning?: boolean }): Promise<number> {
  const result = await migrateToPostgres({
    dryRun: opts.dryRun,
    skipDump: opts.skipDump,
    allowRunning: opts.allowRunning,
  });
  console.log(renderReport(result));
  return result.ok ? 0 : 1;
}
