/**
 * End-to-end proof for `pai db migrate-to-postgres` (unit 6,
 * docs/design/postgres-only.md §4, §8). Builds scratch SQLite
 * federation/registry databases plus a scratch Postgres database
 * (pattern: src/storage/postgres/kg-and-registry-ddl.test.ts), runs the
 * migration twice, and asserts the refusal paths.
 *
 * Never touches the real ~/.claude/pai/federation.db, registry.db, or the
 * real Postgres database.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import BetterSqlite3 from "better-sqlite3";
import pg from "pg";
import type { Pool } from "pg";
import { initializeFederationSchema } from "./sqlite/federation-schema.js";
import { initializeSchema, runMigrations as registryRunMigrations } from "./sqlite/registry-schema.js";
import { PostgresBackend } from "./postgres/backend.js";
import { loadConfig } from "../daemon/config.js";
import type { PaiDaemonConfig } from "../daemon/config.js";

const { Pool: PgPool } = pg;

// ---------------------------------------------------------------------------
// Mock loadConfig() so one test can flip storageBackend without touching the
// real config file. Every other test falls through to the real loadConfig().
// ---------------------------------------------------------------------------

let mockStorageBackend: "sqlite" | "postgres" | null = null;

vi.mock("../daemon/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/config.js")>();
  return {
    ...actual,
    loadConfig: (): PaiDaemonConfig => {
      const real = actual.loadConfig();
      return mockStorageBackend ? { ...real, storageBackend: mockStorageBackend } : real;
    },
  };
});

const { migrateToPostgres, renderReport } = await import("./migrate-to-postgres.js");

// ---------------------------------------------------------------------------
// Scratch Postgres database (same pattern as kg-and-registry-ddl.test.ts)
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const initSql = readFileSync(join(repoRoot, "docker", "init.sql"), "utf-8");

const runPgMigrations = (
  PostgresBackend as unknown as { runMigrations(pool: Pool): Promise<void> }
).runMigrations;

function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
  const base = loadConfig().postgres?.connectionString;
  if (!base) throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
  const dbName = `pai_test_migrate_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
}

// ---------------------------------------------------------------------------
// Scratch SQLite fixtures
// ---------------------------------------------------------------------------

function makeScratchDir(): string {
  return mkdtempSync(join(tmpdir(), "pai-migrate-test-"));
}

const EMBEDDING = Buffer.alloc(768 * 4);
for (let i = 0; i < 768; i++) EMBEDDING.writeFloatLE(0.01 * i, i * 4);

// Stale 384-dim embedding (older model) — must be copied with embedding=NULL, never fail the insert.
const EMBEDDING_384 = Buffer.alloc(384 * 4);
for (let i = 0; i < 384; i++) EMBEDDING_384.writeFloatLE(0.02 * i, i * 4);

function buildFederationDb(path: string): void {
  const db = new BetterSqlite3(path);
  initializeFederationSchema(db);

  // Legacy vault tables (removed from current DDL but still present on real
  // installs that predate the Postgres vault move) — created directly here
  // to exercise the conditional copy path.
  db.exec(`
    CREATE TABLE vault_files (
      vault_path TEXT PRIMARY KEY, inode INTEGER NOT NULL, device INTEGER NOT NULL,
      hash TEXT NOT NULL, title TEXT, indexed_at INTEGER NOT NULL
    );
    CREATE TABLE vault_aliases (
      vault_path TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, inode INTEGER NOT NULL, device INTEGER NOT NULL
    );
    CREATE TABLE vault_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL, target_raw TEXT NOT NULL,
      target_path TEXT, link_type TEXT NOT NULL DEFAULT 'wikilink', line_number INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE vault_name_index (name TEXT NOT NULL, vault_path TEXT NOT NULL, PRIMARY KEY (name, vault_path));
    CREATE TABLE vault_health (
      vault_path TEXT PRIMARY KEY, inbound_count INTEGER NOT NULL DEFAULT 0, outbound_count INTEGER NOT NULL DEFAULT 0,
      dead_link_count INTEGER NOT NULL DEFAULT 0, is_orphan INTEGER NOT NULL DEFAULT 0, computed_at INTEGER NOT NULL
    );
  `);

  // memory_files/memory_chunks: one path already "present" in Postgres
  // (pre-seeded below, identical fields), one path absent.
  db.prepare(
    "INSERT INTO memory_files (project_id, path, source, tier, hash, mtime, size) VALUES (1, 'already.md', 'memory', 'topic', 'h1', 1000, 10)"
  ).run();
  db.prepare(
    "INSERT INTO memory_files (project_id, path, source, tier, hash, mtime, size) VALUES (1, 'new.md', 'memory', 'topic', 'h2', 2000, 20)"
  ).run();

  db.prepare(
    "INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at) VALUES ('c-already', 1, 'memory', 'topic', 'already.md', 1, 5, 'ch1', 'already text', 1000)"
  ).run();
  db.prepare(
    "INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at, embedding) VALUES ('c-new-embedded', 1, 'memory', 'topic', 'new.md', 1, 5, 'ch2', 'new text with embedding', 2000, ?)"
  ).run(EMBEDDING);
  db.prepare(
    "INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at) VALUES ('c-new-unembedded', 1, 'memory', 'topic', 'new.md', 6, 10, 'ch3', 'new text no embedding', 2000)"
  ).run();
  // Stale 384-dim embedding from an older embedding model — pai_chunks.embedding is vector(768).
  db.prepare(
    "INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at, embedding) VALUES ('c-new-dim-mismatch', 1, 'memory', 'topic', 'new.md', 11, 15, 'ch4', 'new text stale embedding', 2000, ?)"
  ).run(EMBEDDING_384);

  // kg_entities: one already present in Postgres, one absent.
  db.prepare(
    "INSERT INTO kg_entities (entity_id, tenant_id, name, type, description, first_seen, last_seen, mention_count, feedback_weight) VALUES ('kge-already', 'default', 'Already Entity', 'person', 'd', 1000, 1000, 1, 0.5)"
  ).run();
  db.prepare(
    "INSERT INTO kg_entities (entity_id, tenant_id, name, type, description, first_seen, last_seen, mention_count, feedback_weight) VALUES ('kge-new', 'default', 'New Entity', 'person', 'd', 2000, 2000, 3, 0.7)"
  ).run();

  // Vault rows: one already-present vault_file, one absent; a link, a name
  // index entry, and a health row all under the absent file's path.
  db.prepare(
    "INSERT INTO vault_files (vault_path, inode, device, hash, title, indexed_at) VALUES ('already.md', 1, 1, 'vh1', 'Already', 1000)"
  ).run();
  db.prepare(
    "INSERT INTO vault_files (vault_path, inode, device, hash, title, indexed_at) VALUES ('new-vault.md', 2, 1, 'vh2', 'New', 2000)"
  ).run();
  db.prepare(
    "INSERT INTO vault_aliases (vault_path, canonical_path, inode, device) VALUES ('new-alias.md', 'new-vault.md', 2, 1)"
  ).run();
  db.prepare(
    "INSERT INTO vault_links (source_path, target_raw, target_path, link_type, line_number) VALUES ('new-vault.md', '[[Target]]', NULL, 'wikilink', 3)"
  ).run();
  db.prepare("INSERT INTO vault_name_index (name, vault_path) VALUES ('New', 'new-vault.md')").run();
  db.prepare(
    "INSERT INTO vault_health (vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at) VALUES ('new-vault.md', 0, 1, 1, 0, 2000)"
  ).run();

  db.close();
}

function buildRegistryDb(path: string): void {
  const db = new BetterSqlite3(path);
  initializeSchema(db);
  registryRunMigrations(db);

  // Project 1: identical to the row pre-seeded in Postgres (already there).
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES (1, 'already', 'Already', '/tmp/already', '-tmp-already', 'local', 'active', 1000, 1000)`
  ).run();
  // Project 2: absent from Postgres.
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES (2, 'newproj', 'New Proj', '/tmp/newproj', '-tmp-newproj', 'local', 'active', 2000, 2000)`
  ).run();

  db.prepare("INSERT INTO tags (id, name) VALUES (1, 'work')").run();
  db.prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (2, 1)").run();

  db.prepare(
    `INSERT INTO sessions (id, project_id, number, date, slug, title, filename, status, created_at)
     VALUES (1, 2, 1, '2026-09-22', 's1', 'Session One', '0001.md', 'completed', 2000)`
  ).run();
  db.prepare("INSERT INTO session_tags (session_id, tag_id) VALUES (1, 1)").run();
  db.prepare("INSERT INTO aliases (alias, project_id) VALUES ('np', 2)").run();
  db.prepare(
    `INSERT INTO links (id, session_id, target_project_id, link_type, created_at) VALUES (1, 1, 1, 'related', 2000)`
  ).run();
  db.prepare(
    `INSERT INTO compaction_log (id, project_id, session_id, trigger, files_written, token_count, created_at)
     VALUES (1, 2, 1, 'manual', 'notes.md', 500, 2000)`
  ).run();

  db.close();
}

async function seedPostgresExisting(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO projects (id, slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES (1, 'already', 'Already', '/tmp/already', '-tmp-already', 'local', 'active', 1000, 1000)`
  );
  await pool.query(
    `INSERT INTO kg_entities (entity_id, tenant_id, name, type, description, first_seen, last_seen, mention_count, feedback_weight)
     VALUES ('kge-already', 'default', 'Already Entity', 'person', 'd', 1000, 1000, 1, 0.5)`
  );
  await pool.query(
    `INSERT INTO pai_files (project_id, path, source, tier, hash, mtime, size) VALUES (1, 'already.md', 'memory', 'topic', 'h1', 1000, 10)`
  );
  await pool.query(
    `INSERT INTO vault_files (vault_path, inode, device, hash, title, indexed_at) VALUES ('already.md', 1, 1, 'vh1', 'Already', 1000)`
  );
}

// ---------------------------------------------------------------------------
// Fake daemon IPC server (Unix socket) — for the "daemon running" refusal.
// ---------------------------------------------------------------------------

function startFakeDaemon(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as { id: string };
        socket.write(JSON.stringify({ id: req.id, ok: true, result: { uptime: 1 } }) + "\n");
      });
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrateToPostgres (unit 6)", () => {
  let scratchDir: string;
  let sqliteFederationPath: string;
  let sqliteRegistryPath: string;
  let scratchUrl: string;
  let adminUrl: string;
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    scratchDir = makeScratchDir();
    sqliteFederationPath = join(scratchDir, "federation.db");
    sqliteRegistryPath = join(scratchDir, "registry.db");
    buildFederationDb(sqliteFederationPath);
    buildRegistryDb(sqliteRegistryPath);

    ({ scratchUrl, adminUrl, dbName } = scratchTargets());
    const admin = new PgPool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    pool = new PgPool({ connectionString: scratchUrl, max: 3 });
    await pool.query(initSql);
    await runPgMigrations(pool);
    await seedPostgresExisting(pool);
  }, 30000);

  afterAll(async () => {
    await pool.end();
    const admin = new PgPool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await admin.end();
    }
    rmSync(scratchDir, { recursive: true, force: true });
  }, 30000);

  it("migrates every missing row and reports zero missing after", async () => {
    const result = await migrateToPostgres({
      skipConfigGate: true,
      skipDump: true,
      allowRunning: true,
      pgConfig: { connectionString: scratchUrl },
      sqliteFederationPath,
      sqliteRegistryPath,
    });

    expect(result.refused).toBeUndefined();
    expect(result.ok).toBe(true);

    const byTable = Object.fromEntries(result.tables.map((t) => [t.table, t]));

    expect(byTable["projects"].copied).toBe(1); // only project 2 was missing
    expect(byTable["projects"].missingAfter).toBe(0);
    expect(byTable["kg_entities"].copied).toBe(1); // only kge-new was missing
    expect(byTable["kg_entities"].missingAfter).toBe(0);
    expect(byTable["memory_files -> pai_files"].copied).toBe(1); // only new.md
    expect(byTable["memory_files -> pai_files"].missingAfter).toBe(0);
    expect(byTable["memory_chunks -> pai_chunks"].copied).toBe(3); // all three chunks under new.md
    expect(byTable["memory_chunks -> pai_chunks"].missingAfter).toBe(0);
    expect(byTable["vault_files"].copied).toBe(1);
    expect(byTable["vault_files"].missingAfter).toBe(0);
    expect(byTable["vault_links"].copied).toBe(1);
    expect(byTable["vault_health"].copied).toBe(1);
    expect(byTable["vault_name_index"].copied).toBe(1);

    for (const t of result.tables) expect(t.missingAfter).toBe(0);

    expect(result.embeddingsNote).toMatch(/1 copied with embedding/);
    expect(result.embeddingsNote).toMatch(/2 copied without \(dimension mismatch, re-embedded by the daemon\)/);

    // Chunk with an embedding actually copied its vector, not NULL.
    const embedded = await pool.query<{ embedding: string | null }>(
      "SELECT embedding::text AS embedding FROM pai_chunks WHERE id = 'c-new-embedded'"
    );
    expect(embedded.rows[0].embedding).not.toBeNull();
    const unembedded = await pool.query<{ embedding: string | null }>(
      "SELECT embedding::text AS embedding FROM pai_chunks WHERE id = 'c-new-unembedded'"
    );
    expect(unembedded.rows[0].embedding).toBeNull();

    // Stale 384-dim embedding: inserted with embedding=NULL instead of failing the batch —
    // proof for the "expected 768 dimensions, not 384" bug (docker/init.sql pai_chunks.embedding is vector(768)).
    const dimMismatch = await pool.query<{ embedding: string | null }>(
      "SELECT embedding::text AS embedding FROM pai_chunks WHERE id = 'c-new-dim-mismatch'"
    );
    expect(dimMismatch.rows[0].embedding).toBeNull();

    // Sequence continues after the preserved explicit id (max project id = 2).
    const seqCheck = await pool.query(
      `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES ('seq-check', 'Seq Check', '/tmp/seq-check', '-tmp-seq-check', 'local', 'active', 3000, 3000)
       RETURNING id`
    );
    expect(seqCheck.rows[0].id).toBeGreaterThan(2);

    const report = renderReport(result);
    expect(report).toContain("OK: no missing rows");
  }, 30000);

  it("is idempotent: a second run copies nothing and still verifies zero missing", async () => {
    const result = await migrateToPostgres({
      skipConfigGate: true,
      skipDump: true,
      allowRunning: true,
      pgConfig: { connectionString: scratchUrl },
      sqliteFederationPath,
      sqliteRegistryPath,
    });

    expect(result.ok).toBe(true);
    for (const t of result.tables) {
      expect(t.copied).toBe(0);
      expect(t.missingAfter).toBe(0);
    }
  }, 30000);

  it("refuses when storageBackend is not postgres", async () => {
    mockStorageBackend = "sqlite";
    try {
      const result = await migrateToPostgres({
        skipDump: true,
        allowRunning: true,
        pgConfig: { connectionString: scratchUrl },
        sqliteFederationPath,
        sqliteRegistryPath,
      });
      expect(result.ok).toBe(false);
      expect(result.refused).toMatch(/storageBackend/);
      expect(renderReport(result)).toContain("REFUSED");
    } finally {
      mockStorageBackend = null;
    }
  });

  it("refuses when the daemon is running and --allow-running is not passed", async () => {
    const fakeSocketPath = join(scratchDir, "fake-daemon.sock");
    const server = await startFakeDaemon(fakeSocketPath);
    try {
      const result = await migrateToPostgres({
        skipConfigGate: true,
        skipDump: true,
        pgConfig: { connectionString: scratchUrl },
        sqliteFederationPath,
        sqliteRegistryPath,
        socketPath: fakeSocketPath,
      });
      expect(result.ok).toBe(false);
      expect(result.refused).toMatch(/daemon is running/);
    } finally {
      server.close();
    }
  });

  it("rejects (does not resolve ok:true) on an unrecoverable Postgres failure", async () => {
    // Unreachable port — ensureDatabase()'s connection attempt fails fast. A
    // rejected promise is an unhandled rejection at the CLI call site, which
    // Node itself exits non-zero for, unlike a resolved {ok:false} that
    // depends on the CLI's own `if (!result.ok) process.exitCode = 1`.
    await expect(
      migrateToPostgres({
        skipConfigGate: true,
        skipDump: true,
        allowRunning: true,
        pgConfig: { connectionString: "postgresql://pai:pai@127.0.0.1:1/nope", connectionTimeoutMs: 500 },
        sqliteFederationPath,
        sqliteRegistryPath,
      })
    ).rejects.toThrow();
  }, 15000);

  it("dry-run makes no writes and skips the dump", async () => {
    const before = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM projects");
    const result = await migrateToPostgres({
      dryRun: true,
      skipConfigGate: true,
      pgConfig: { connectionString: scratchUrl },
      sqliteFederationPath,
      sqliteRegistryPath,
    });
    const after = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM projects");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(result.dumpPath).toBeUndefined();
    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(true);
    for (const t of result.tables) expect(t.copied).toBe(0);
  }, 30000);
});
