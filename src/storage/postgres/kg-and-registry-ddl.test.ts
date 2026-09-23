import { describe, it, expect } from "vitest";
import pg from "pg";
import type { Pool as PgPool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresBackend } from "./backend.js";
import { loadConfig } from "../../daemon/config.js";

/**
 * Unit 1 proof: runMigrations() creates kg_entities plus the 7 registry
 * tables, and running it twice (ensureDatabase → runMigrations internally)
 * is a no-op — every statement is CREATE ... IF NOT EXISTS, so a second pass
 * must not throw and must not duplicate anything.
 *
 * Runs against a scratch database on the same Postgres server as configured
 * PAI, created and dropped here — never touches the real database.
 */

const { Pool } = pg;

const REQUIRED_TABLES = [
  "kg_entities",
  "projects",
  "sessions",
  "tags",
  "project_tags",
  "session_tags",
  "aliases",
  "compaction_log",
  "links",
];

const REQUIRED_INDEXES = [
  "idx_kge_tenant",
  "idx_kge_name",
  "idx_kge_type",
  "idx_projects_slug",
  "idx_projects_status",
  "idx_projects_type",
  "idx_sessions_project",
  "idx_sessions_date",
  "idx_sessions_status",
  "idx_sessions_claude",
  "idx_pc_project",
];

// backend.ts resolves docker/init.sql relative to the built dist/ layout, which
// does not match ts-source paths under vitest — read it directly here instead.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const initSql = readFileSync(join(repoRoot, "docker", "init.sql"), "utf-8");

/** Private on PostgresBackend at compile time only — real code under test. */
const runMigrations = (
  PostgresBackend as unknown as { runMigrations(pool: PgPool): Promise<void> }
).runMigrations;

function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
  const base = loadConfig().postgres?.connectionString;
  if (!base) {
    throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
  }
  const dbName = `pai_test_ddl_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
}

describe("Postgres DDL: kg_entities + registry tables (unit 1)", () => {
  it("creates all 8 tables + indexes, idempotently across two migration passes", async () => {
    const { scratchUrl, adminUrl, dbName } = scratchTargets();

    try {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end();
      }

      const pool = new Pool({ connectionString: scratchUrl, max: 1 });
      try {
        await pool.query(initSql);
        // First pass: creates kg_entities + registry tables.
        await runMigrations(pool);
        // Second pass on the now-migrated database: must not throw, must not
        // duplicate anything — this is the idempotency proof.
        await runMigrations(pool);

        const tables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = ANY($1)`,
          [REQUIRED_TABLES]
        );

        const foundNames = tables.rows.map((r) => r.table_name).sort();
        expect(foundNames).toEqual([...REQUIRED_TABLES].sort());

        // No duplication: exactly one catalog row per table name.
        for (const t of REQUIRED_TABLES) {
          expect(tables.rows.filter((r) => r.table_name === t)).toHaveLength(1);
        }

        const indexes = await pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = 'public' AND indexname = ANY($1)`,
          [REQUIRED_INDEXES]
        );
        expect(indexes.rows.map((r) => r.indexname).sort()).toEqual([...REQUIRED_INDEXES].sort());
      } finally {
        await pool.end();
      }
    } finally {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin.end();
      }
    }
  }, 30000);
});
