import pg from "pg";
import type { Pool as PgPool } from "pg";
import { PostgresBackend } from "./postgres/backend.js";
import { PostgresRegistryBackend } from "./registry-postgres.js";
import { defineRegistryBackendContract } from "./registry-contract.js";
import { loadConfig } from "../daemon/config.js";

/**
 * Unit 4 proof: PostgresRegistryBackend runs the same contract suite as
 * SQLiteRegistryBackend (registry-sqlite.test.ts), against a scratch
 * database created and dropped here — never the real one.
 */

const { Pool } = pg;

function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
  const base = loadConfig().postgres?.connectionString;
  if (!base) {
    throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
  }
  const dbName = `pai_test_registry_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
}

defineRegistryBackendContract("postgres", async () => {
  const { scratchUrl, adminUrl, dbName } = scratchTargets();

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: scratchUrl, max: 1 });
  try {
    const repoRoot = new URL("../../docker/init.sql", import.meta.url);
    const { readFileSync } = await import("node:fs");
    const initSql = readFileSync(repoRoot, "utf-8");
    await pool.query(initSql);
    const runMigrations = (
      PostgresBackend as unknown as { runMigrations(p: PgPool): Promise<void> }
    ).runMigrations;
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  const backend = new PostgresRegistryBackend({ connectionString: scratchUrl });

  return {
    backend,
    cleanup: async () => {
      try {
        await backend.close();
      } catch {
        // already closed by the coverage-gate test
      }
      const admin2 = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin2.end();
      }
    },
  };
});
