import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Pool as PgPool } from "pg";
import type { Database } from "better-sqlite3";
import { openFederation } from "./sqlite/federation-db.js";
import { SQLiteBackend } from "./sqlite.js";
import { PostgresBackend } from "./postgres/backend.js";
import type { StorageBackend } from "./interface.js";
import { loadConfig } from "../daemon/config.js";

// backend.ts resolves docker/init.sql relative to the built dist/ layout, which
// does not match ts-source paths under vitest — read it directly here instead.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const initSql = readFileSync(join(repoRoot, "docker", "init.sql"), "utf-8");

/** Private on PostgresBackend at compile time only — real code under test. */
const runMigrations = (
  PostgresBackend as unknown as { runMigrations(pool: PgPool): Promise<void> }
).runMigrations;

/**
 * Unit 2 proof: SQLiteBackend and PostgresBackend implement the same
 * kg_entities contract with identical observable results, exercised against
 * a temp SQLite file and a scratch Postgres database (never the real ones).
 */

const { Pool } = pg;

function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
  const base = loadConfig().postgres?.connectionString;
  if (!base) {
    throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
  }
  const dbName = `pai_test_kge_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
}

describe("kg_entities: SQLiteBackend and PostgresBackend behave identically", () => {
  let tmpDir: string;
  let sqliteDb: Database;
  let sqlite: StorageBackend;

  let scratchUrl: string;
  let adminUrl: string;
  let dbName: string;
  let postgres: PostgresBackend;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pai-kg-entities-test-"));
    sqliteDb = openFederation(join(tmpDir, "federation.db"));
    sqlite = new SQLiteBackend(sqliteDb);

    ({ scratchUrl, adminUrl, dbName } = scratchTargets());

    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    const setupPool = new Pool({ connectionString: scratchUrl, max: 1 });
    try {
      await setupPool.query(initSql);
      await runMigrations(setupPool);
    } finally {
      await setupPool.end();
    }

    postgres = new PostgresBackend({ connectionString: scratchUrl });
  }, 30000);

  afterAll(async () => {
    sqliteDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    await postgres.close();
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await admin.end();
    }
  }, 30000);

  function backends(): Array<[string, StorageBackend]> {
    return [
      ["sqlite", sqlite],
      ["postgres", postgres],
    ];
  }

  it("upsertKgEntity is deterministic and increments mention_count on repeat calls", async () => {
    for (const [label, backend] of backends()) {
      const id1 = await backend.upsertKgEntity({ name: "Widget", type: "tool", description: "a thing" });
      const id2 = await backend.upsertKgEntity({ name: "Widget", type: "tool" });
      expect(id2, label).toBe(id1);

      const entity = await backend.findKgEntity("Widget");
      expect(entity, label).not.toBeNull();
      expect(entity!.name, label).toBe("Widget");
      expect(entity!.type, label).toBe("tool");
      expect(entity!.description, label).toBe("a thing");
      expect(entity!.mention_count, label).toBe(2);
      expect(entity!.feedback_weight, label).toBe(0.5);
    }
  }, 30000);

  it("findKgEntity returns null for an unknown entity", async () => {
    for (const [label, backend] of backends()) {
      expect(await backend.findKgEntity("no-such-entity"), label).toBeNull();
    }
  }, 30000);

  it("listKgEntities filters by type and respects limit, ordered by mention_count desc", async () => {
    for (const [label, backend] of backends()) {
      await backend.upsertKgEntity({ name: "Gadget", type: "tool" });
      await backend.upsertKgEntity({ name: "Alice", type: "person" });

      const tools = await backend.listKgEntities("default", "tool", 10);
      expect(tools.map((e) => e.name).sort(), label).toEqual(["Gadget", "Widget"]);
      // Widget was upserted twice above — higher mention_count sorts first.
      expect(tools[0].name, label).toBe("Widget");

      const limited = await backend.listKgEntities("default", undefined, 1);
      expect(limited, label).toHaveLength(1);
    }
  }, 30000);

  it("updateEntityFeedbackWeight applies the EMA formula and no-ops for an unknown id", async () => {
    for (const [label, backend] of backends()) {
      const before = (await backend.findKgEntity("Widget"))!;
      await backend.updateEntityFeedbackWeight(before.entity_id, 1.0, 0.1);
      const after = (await backend.findKgEntity("Widget"))!;
      expect(after.feedback_weight, label).toBeCloseTo(
        before.feedback_weight + 0.1 * (1.0 - before.feedback_weight),
        10
      );

      // No matching row — must not throw.
      await expect(
        backend.updateEntityFeedbackWeight("does-not-exist", 1.0, 0.1)
      ).resolves.toBeUndefined();
    }
  }, 30000);

  it("keeps separate tenants isolated", async () => {
    for (const [label, backend] of backends()) {
      await backend.upsertKgEntity({ name: "Widget", type: "tool", tenantId: "tenant-b" });
      const defaultEntity = await backend.findKgEntity("Widget", "default");
      const tenantBEntity = await backend.findKgEntity("Widget", "tenant-b");
      expect(defaultEntity!.entity_id, label).not.toBe(tenantBEntity!.entity_id);
      expect(tenantBEntity!.mention_count, label).toBe(1);
    }
  }, 30000);
});
