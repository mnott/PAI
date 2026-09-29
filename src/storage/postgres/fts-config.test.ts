import { describe, it, expect } from "vitest";
import pg from "pg";
import type { Pool as PgPool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../daemon/config.js";
import { migrateFtsConfig } from "./fts-migration.js";
import type { StorageBackend } from "../interface.js";

function backendFor(pool: PgPool): StorageBackend {
  return { getPool: () => pool } as unknown as StorageBackend;
}

/**
 * Proof for the fts_vector 'english' -> 'simple' bug: a BEFORE trigger using
 * the wrong text-search config silently overwrote every insert, so stemmed
 * words like "running" were never found by `to_tsquery('simple', ...)`.
 *
 * Runs against scratch databases on the same Postgres server as configured
 * PAI, created and dropped here — never touches the real database.
 */

const { Pool } = pg;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const initSql = readFileSync(join(repoRoot, "docker", "init.sql"), "utf-8");

const LEGACY_TRIGGER_FN = `
  CREATE OR REPLACE FUNCTION pai_chunks_fts_update()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.fts_vector := to_tsvector('english', COALESCE(NEW.text, ''));
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
  const base = loadConfig().postgres?.connectionString;
  if (!base) {
    throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
  }
  const dbName = `pai_test_fts_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
}

async function withScratchDb(fn: (pool: PgPool) => Promise<void>): Promise<void> {
  const { scratchUrl, adminUrl, dbName } = scratchTargets();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: scratchUrl, max: 1 });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    const admin2 = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await admin2.end();
    }
  }
}

async function insertChunk(pool: PgPool, id: string, text: string): Promise<void> {
  await pool.query(
    `INSERT INTO pai_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at)
     VALUES ($1, 1, 'memory', 'topic', 'x.md', 1, 1, 'h', $2, 0)`,
    [id, text]
  );
}

async function findsRunning(pool: PgPool, id: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM pai_chunks WHERE id = $1 AND fts_vector @@ to_tsquery('simple', 'running')`,
    [id]
  );
  return (r.rowCount ?? 0) > 0;
}

async function marker(pool: PgPool): Promise<string | null> {
  const r = await pool.query<{ comment: string | null }>(
    `SELECT col_description('pai_chunks'::regclass, ordinal_position) AS comment
     FROM information_schema.columns
     WHERE table_name = 'pai_chunks' AND column_name = 'fts_vector'`
  );
  return r.rows[0]?.comment ?? null;
}

describe("Postgres FTS config migration (fts_vector 'english' -> 'simple')", () => {
  it("fresh schema: marker gets set and a stemmed word is findable via 'simple'", async () => {
    await withScratchDb(async (pool) => {
      await pool.query(initSql);
      await insertChunk(pool, "c1", "The process is running right now.");

      expect(await findsRunning(pool, "c1")).toBe(true);

      await migrateFtsConfig(backendFor(pool));

      expect(await marker(pool)).toBe("fts:simple");
      expect(await findsRunning(pool, "c1")).toBe(true);
    });
  }, 30000);

  it("legacy schema (english trigger): migration rebuilds rows and sets marker", async () => {
    await withScratchDb(async (pool) => {
      await pool.query(initSql);
      await pool.query(LEGACY_TRIGGER_FN);

      await insertChunk(pool, "c1", "The process is running right now.");
      // Reproduces the measured bug: trigger stemmed/stripped the word away.
      expect(await findsRunning(pool, "c1")).toBe(false);

      await migrateFtsConfig(backendFor(pool));

      expect(await marker(pool)).toBe("fts:simple");
      expect(await findsRunning(pool, "c1")).toBe(true);

      // New writes after migration are correct immediately (trigger fixed).
      await insertChunk(pool, "c2", "Another chunk, also running.");
      expect(await findsRunning(pool, "c2")).toBe(true);
    });
  }, 30000);

  it("second run is a no-op: no UPDATE is issued once the marker is set", async () => {
    await withScratchDb(async (pool) => {
      await pool.query(initSql);
      await insertChunk(pool, "c1", "The process is running right now.");
      await migrateFtsConfig(backendFor(pool));
      expect(await marker(pool)).toBe("fts:simple");

      const queries: string[] = [];
      const originalQuery = pool.query.bind(pool);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = (...args: any[]) => {
        if (typeof args[0] === "string") queries.push(args[0]);
        return originalQuery(...(args as Parameters<typeof originalQuery>));
      };

      await migrateFtsConfig(backendFor(pool));

      const updates = queries.filter((q) => /UPDATE\s+pai_chunks/i.test(q));
      expect(updates).toHaveLength(0);
    });
  }, 30000);
});
