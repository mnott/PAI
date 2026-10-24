import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function makeFixture() {
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
    scratchUrl,
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
}

defineRegistryBackendContract("postgres", makeFixture);

describe("postgres registry: a reset keeps ids reachable", () => {
  let fx: Awaited<ReturnType<typeof makeFixture>>;
  let pool: PgPool;
  beforeEach(async () => {
    fx = await makeFixture();
    pool = new Pool({ connectionString: fx.scratchUrl, max: 1 });
  });
  afterEach(async () => {
    await pool.end();
    await fx.cleanup();
  });

  const input = (slug: string) => ({
    baseSlug: slug, displayName: slug, rootPath: `/tmp/${slug}`, encodedDir: `-tmp-${slug}`, createdAt: 1, updatedAt: 1,
  });
  const chunk = (id: string, pid: number, path: string, vec: boolean) =>
    pool.query(
      `INSERT INTO pai_chunks (id, project_id, path, start_line, end_line, hash, text, updated_at, embedding)
       VALUES ($1, $2, $3, 1, 2, 'h', 't', 1, ${vec ? "('[' || array_to_string(array_fill(0.1::float8, ARRAY[768]), ',') || ']')::vector" : "NULL"})`,
      [id, pid, path]
    );
  const owner = async (id: string) => Number((await pool.query("SELECT project_id FROM pai_chunks WHERE id = $1", [id])).rows[0]?.project_id);

  it("re-registering a project that still owns chunks reuses its id, and the sequence stays ahead", async () => {
    const a = await fx.backend.createProjectWithSlugRetry(input("alpha"));
    const b = await fx.backend.createProjectWithSlugRetry(input("beta"));
    await chunk("c1", a.id, "a.md", true);
    const r = await fx.backend.resetRegistry();
    expect(r.projects).toBe(2);
    expect(r.backupTable).toMatch(/^projects_backup_\d+$/);
    // beta owns no chunks: fresh id; alpha: its old id
    const b2 = await fx.backend.createProjectWithSlugRetry(input("beta"));
    const a2 = await fx.backend.createProjectWithSlugRetry(input("alpha"));
    expect(a2.id).toBe(a.id);
    expect(b2.id).not.toBe(b.id);
    const c = await fx.backend.createProject({ slug: "gamma", displayName: "g", rootPath: "/tmp/gamma", encodedDir: "-tmp-gamma", createdAt: 1, updatedAt: 1 });
    expect(c.id).toBeGreaterThan(Math.max(a2.id, b2.id));
    expect((await fx.backend.countOrphanedChunks()).orphaned).toBe(0);
  });

  it("keeps the last 3 backups and does not rotate on an empty table", async () => {
    for (let i = 0; i < 5; i++) {
      await fx.backend.createProjectWithSlugRetry(input(`p${i}`));
      await fx.backend.resetRegistry();
      await new Promise((res) => setTimeout(res, 3));
    }
    expect((await fx.backend.resetRegistry()).backupTable).toBeNull();
    const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'projects\\_backup\\_%'");
    expect(t.rows).toHaveLength(3);
  });

  it("repair-orphans: dry run counts, execute re-points and drops the vectorless duplicate, delete removes twins", async () => {
    const a = await fx.backend.createProjectWithSlugRetry(input("alpha"));
    const b = await fx.backend.createProjectWithSlugRetry(input("beta"));
    await chunk("a-old", a.id, "a.md", true);
    await chunk("b-old", b.id, "b.md", true);
    await fx.backend.resetRegistry();
    // simulate the incident: new ids with vectorless re-chunks, old chunks orphaned
    await pool.query("INSERT INTO projects (id, slug, display_name, root_path, encoded_dir, created_at, updated_at) VALUES (9001,'alpha','alpha','/tmp/alpha','-tmp-alpha',1,1),(9002,'beta','beta','/tmp/beta','-tmp-beta',1,1)");
    await chunk("a-new", 9001, "a.md", false);
    await chunk("b-new", 9002, "b.md", true); // beta already has vectors: the orphan is a twin
    await pool.query("INSERT INTO pai_files (project_id, path, hash, mtime, size) VALUES ($1,'a.md','x',1,1),(9001,'a.md','y',1,1)", [a.id]);
    expect((await fx.backend.countOrphanedChunks()).orphaned).toBe(2);

    const dry = await fx.backend.repairOrphans({ dryRun: true });
    expect(dry).toMatchObject({ orphanChunks: 2, mappedIds: 2, repointedChunks: 1, droppedDuplicateChunks: 1, repointedFiles: 1, droppedDuplicateFiles: 1 });
    expect(await owner("a-old")).toBe(a.id);

    const done = await fx.backend.repairOrphans({ dryRun: false });
    expect(done.repointedChunks).toBe(1);
    expect(await owner("a-old")).toBe(9001);
    expect(await owner("a-new")).toBeNaN();
    expect((await fx.backend.countOrphanedChunks()).orphaned).toBe(1); // b-old, the twin

    const del = await fx.backend.repairOrphans({ dryRun: false, deleteTwins: true });
    expect(del.deletedTwinChunks).toBe(1);
    expect((await fx.backend.countOrphanedChunks()).orphaned).toBe(0);
  });
});
