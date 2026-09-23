/**
 * migrate-to-postgres.ts — one-shot SQLite -> Postgres migration
 * (`pai db migrate-to-postgres`, docs/design/postgres-only.md §4, §8).
 *
 * Copies kg_entities, every registry table, and the memory/vault rows that
 * are absent from Postgres by natural key. Idempotent: every insert is
 * `ON CONFLICT DO NOTHING`, so a re-run (or a run against a database that
 * already has some rows) just verifies zero rows missing and copies nothing
 * new. Never deletes or renames the SQLite files — the operator does that
 * after reviewing the verify output.
 *
 * The only module allowed to hold both a better-sqlite3 handle and a `pg`
 * pool at once (it lives in src/storage/, where that is the point).
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { loadConfig } from "../daemon/config.js";
import { federationDbPath } from "./sqlite/federation-db.js";
import { registryDbPath } from "./sqlite/registry-db.js";
import { paiHomePath } from "../config/pai-home.js";
import { PaiClient } from "../daemon/ipc-client.js";
import type { PostgresConfig } from "./postgres/config.js";

const { Pool: PgPool } = pg;

const DEFAULT_CONTAINER = "pai-pgvector";
const PG_DATA_DEST = "/var/lib/postgresql/data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  /** Preflight + counts only. No writes, no pg_dump. */
  dryRun?: boolean;
  /** Skip the pg_dump rollback artefact. Tests only. */
  skipDump?: boolean;
  /** Skip the "daemon must not be running" refusal. Tests only. */
  allowRunning?: boolean;
  /** docker container name. Default "pai-pgvector". */
  container?: string;
  /** Override the SQLite federation.db path (tests: a scratch file). */
  sqliteFederationPath?: string;
  /** Override the SQLite registry.db path (tests: a scratch file). */
  sqliteRegistryPath?: string;
  /** Override the Postgres connection (tests: a scratch database). */
  pgConfig?: PostgresConfig;
  /** Override the daemon IPC socket path (tests). */
  socketPath?: string;
  /** Skip the storageBackend:"postgres" config gate (tests only). */
  skipConfigGate?: boolean;
}

export interface TableReport {
  table: string;
  sqliteRows: number;
  postgresRowsBefore: number;
  copied: number;
  missingAfter: number;
}

export interface MigrationResult {
  ok: boolean;
  dryRun: boolean;
  refused?: string;
  dumpPath?: string;
  tables: TableReport[];
  embeddingsNote: string;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function resolvePgConnectionString(config: PostgresConfig): string {
  return (
    config.connectionString ??
    `postgresql://${config.user ?? "pai"}:${config.password ?? "pai"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database ?? "pai"}`
  );
}

function resolvePgDatabaseName(config: PostgresConfig): string {
  if (config.database) return config.database;
  return new URL(resolvePgConnectionString(config)).pathname.slice(1) || "pai";
}

interface DockerMount {
  Type: string;
  Source: string;
  Destination: string;
}

function checkBindMount(container: string): { ok: true } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = execFileSync("docker", ["inspect", container, "--format", "{{json .Mounts}}"], {
      encoding: "utf-8",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return { ok: false, reason: `docker inspect ${container} failed — is the container running? (${msg})` };
  }

  let mounts: DockerMount[];
  try {
    mounts = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `docker inspect ${container}: could not parse mount list` };
  }

  const dataMount = mounts.find((m) => m.Destination === PG_DATA_DEST);
  if (!dataMount) {
    return { ok: false, reason: `${container}: no mount at ${PG_DATA_DEST} — refusing` };
  }
  if (dataMount.Type !== "bind") {
    return {
      ok: false,
      reason: `${container}: ${PG_DATA_DEST} is a "${dataMount.Type}" mount, not "bind" — refusing (the backup/rollback guarantee for the destination would not hold)`,
    };
  }
  return { ok: true };
}

async function checkDaemonNotRunning(socketPath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = new PaiClient(socketPath);
  try {
    await client.call("status", {}, 1500);
    return {
      ok: false,
      reason: "PAI daemon is running — stop it first (pai daemon restart / launchctl unload) or pass --allow-running (tests only)",
    };
  } catch {
    // ENOENT/ECONNREFUSED/timeout all mean "nothing answered" — daemon not running.
    return { ok: true };
  }
}

function pgDump(
  container: string,
  pgConfig: PostgresConfig,
  destPath: string
): { ok: true } | { ok: false; reason: string } {
  const database = resolvePgDatabaseName(pgConfig);
  const user = pgConfig.user ?? "pai";
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    execSync(`docker exec ${container} pg_dump -U ${user} -Fc ${database} > "${destPath}"`, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true as unknown as string,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return { ok: false, reason: `pg_dump failed: ${msg}` };
  }
  if (!existsSync(destPath) || statSync(destPath).size === 0) {
    return { ok: false, reason: `pg_dump produced an empty file at ${destPath}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Generic copy-by-natural-key helper
// ---------------------------------------------------------------------------

interface CopyPlan<TRow> {
  table: string;
  sqliteRows: TRow[];
  /** Natural-key string for a row — used to diff SQLite against Postgres. */
  keyFn: (row: TRow) => string;
  /** SELECT that returns one column: the same key string, for every existing Postgres row. */
  pgKeySql: string;
  pgKeyParams?: unknown[];
  insertSql: string;
  paramsFn: (row: TRow) => unknown[];
}

async function countRows(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query<{ n: string }>(sql, params);
  return parseInt(r.rows[0]?.n ?? "0", 10);
}

/**
 * Insert every SQLite row whose natural key is absent from Postgres, in one
 * transaction, then report sqlite/postgres-before/copied/missing-after —
 * missing-after is recomputed from Postgres after the insert, so a partial
 * failure (caught, rolled back) is visible as a non-zero count rather than a
 * silent gap.
 */
async function copyByKey<TRow>(pool: Pool, dryRun: boolean, plan: CopyPlan<TRow>): Promise<TableReport> {
  const sqliteRows = plan.sqliteRows;
  const pgKeysBefore = await pool.query<{ k: string }>(plan.pgKeySql, plan.pgKeyParams ?? []);
  const beforeSet = new Set(pgKeysBefore.rows.map((r) => r.k));
  const postgresRowsBefore = beforeSet.size;

  const missing = sqliteRows.filter((row) => !beforeSet.has(plan.keyFn(row)));

  let copied = 0;
  if (!dryRun && missing.length > 0) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of missing) {
        const r = await client.query(plan.insertSql, plan.paramsFn(row));
        copied += r.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  const pgKeysAfter = dryRun
    ? pgKeysBefore
    : await pool.query<{ k: string }>(plan.pgKeySql, plan.pgKeyParams ?? []);
  const afterSet = dryRun ? beforeSet : new Set(pgKeysAfter.rows.map((r) => r.k));
  const missingAfter = dryRun ? missing.length : sqliteRows.filter((row) => !afterSet.has(plan.keyFn(row))).length;

  return {
    table: plan.table,
    sqliteRows: sqliteRows.length,
    postgresRowsBefore,
    copied: dryRun ? 0 : copied,
    missingAfter,
  };
}

async function setSerialSequence(pool: Pool, table: string, column: string): Promise<void> {
  await pool.query(
    `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT MAX(${column}) FROM ${table}), 1), 1))`,
    [table, column]
  );
}

// ---------------------------------------------------------------------------
// Registry tables (projects -> tags -> sessions -> project_tags ->
// session_tags -> aliases -> links -> compaction_log)
// ---------------------------------------------------------------------------

async function copyRegistryTables(
  sqlite: Database,
  pool: Pool,
  dryRun: boolean,
  tables: TableReport[]
): Promise<void> {
  type Row = Record<string, unknown>;
  const all = (table: string): Row[] => sqlite.prepare(`SELECT * FROM ${table}`).all() as Row[];

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "projects",
      sqliteRows: all("projects"),
      keyFn: (r) => String(r.id),
      pgKeySql: "SELECT id::text AS k FROM projects",
      insertSql: `INSERT INTO projects
         (id, slug, display_name, root_path, encoded_dir, type, status, parent_id, obsidian_link, claude_notes_dir, session_config, created_at, updated_at, archived_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [
        r.id, r.slug, r.display_name, r.root_path, r.encoded_dir, r.type, r.status,
        r.parent_id, r.obsidian_link, r.claude_notes_dir, r.session_config, r.created_at, r.updated_at, r.archived_at,
      ],
    })
  );
  if (!dryRun) await setSerialSequence(pool, "projects", "id");

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "tags",
      sqliteRows: all("tags"),
      keyFn: (r) => String(r.id),
      pgKeySql: "SELECT id::text AS k FROM tags",
      insertSql: `INSERT INTO tags (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [r.id, r.name],
    })
  );
  if (!dryRun) await setSerialSequence(pool, "tags", "id");

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "sessions",
      sqliteRows: all("sessions"),
      keyFn: (r) => String(r.id),
      pgKeySql: "SELECT id::text AS k FROM sessions",
      insertSql: `INSERT INTO sessions
         (id, project_id, number, date, slug, title, filename, status, claude_session_id, token_count, created_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [
        r.id, r.project_id, r.number, r.date, r.slug, r.title, r.filename, r.status,
        r.claude_session_id, r.token_count, r.created_at, r.closed_at,
      ],
    })
  );
  if (!dryRun) await setSerialSequence(pool, "sessions", "id");

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "project_tags",
      sqliteRows: all("project_tags"),
      keyFn: (r) => `${r.project_id}:${r.tag_id}`,
      pgKeySql: "SELECT project_id::text || ':' || tag_id::text AS k FROM project_tags",
      insertSql: `INSERT INTO project_tags (project_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [r.project_id, r.tag_id],
    })
  );

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "session_tags",
      sqliteRows: all("session_tags"),
      keyFn: (r) => `${r.session_id}:${r.tag_id}`,
      pgKeySql: "SELECT session_id::text || ':' || tag_id::text AS k FROM session_tags",
      insertSql: `INSERT INTO session_tags (session_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [r.session_id, r.tag_id],
    })
  );

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "aliases",
      sqliteRows: all("aliases"),
      keyFn: (r) => String(r.alias),
      pgKeySql: "SELECT alias AS k FROM aliases",
      insertSql: `INSERT INTO aliases (alias, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [r.alias, r.project_id],
    })
  );

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "links",
      sqliteRows: all("links"),
      keyFn: (r) => String(r.id),
      pgKeySql: "SELECT id::text AS k FROM links",
      insertSql: `INSERT INTO links (id, session_id, target_project_id, link_type, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [r.id, r.session_id, r.target_project_id, r.link_type, r.created_at],
    })
  );
  if (!dryRun) await setSerialSequence(pool, "links", "id");

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "compaction_log",
      sqliteRows: all("compaction_log"),
      keyFn: (r) => String(r.id),
      pgKeySql: "SELECT id::text AS k FROM compaction_log",
      insertSql: `INSERT INTO compaction_log (id, project_id, session_id, trigger, files_written, token_count, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      paramsFn: (r) => [r.id, r.project_id, r.session_id, r.trigger, r.files_written, r.token_count, r.created_at],
    })
  );
  if (!dryRun) await setSerialSequence(pool, "compaction_log", "id");
}

// ---------------------------------------------------------------------------
// kg_entities
// ---------------------------------------------------------------------------

async function copyKgEntities(sqlite: Database, pool: Pool, dryRun: boolean, tables: TableReport[]): Promise<void> {
  type Row = Record<string, unknown>;
  const rows = sqlite.prepare("SELECT * FROM kg_entities").all() as Row[];

  tables.push(
    await copyByKey<Row>(pool, dryRun, {
      table: "kg_entities",
      sqliteRows: rows,
      keyFn: (r) => String(r.entity_id),
      pgKeySql: "SELECT entity_id AS k FROM kg_entities",
      insertSql: `INSERT INTO kg_entities
         (entity_id, tenant_id, name, type, description, first_seen, last_seen, mention_count, feedback_weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (entity_id) DO NOTHING`,
      paramsFn: (r) => [
        r.entity_id, r.tenant_id, r.name, r.type, r.description,
        r.first_seen, r.last_seen, r.mention_count, r.feedback_weight,
      ],
    })
  );
}

// ---------------------------------------------------------------------------
// memory_files/memory_chunks -> pai_files/pai_chunks
//
// Missing is decided at the (project_id, path) file level, not per chunk: a
// path already indexed into Postgres may have been re-chunked differently on
// a later run, so only paths Postgres has never seen at all are copied —
// file row plus every chunk under that path.
// ---------------------------------------------------------------------------

/**
 * SQLite chunks may carry embeddings from an older model with a different
 * dimension than pai_chunks.embedding (vector(N)) — inserting a mismatched
 * literal fails the whole batch. `dimension` is the live column width; a
 * blob whose float count doesn't match it is treated the same as "no
 * embedding" so the row still copies and the daemon re-embeds it.
 */
function blobToVectorLiteral(buf: Buffer | null, dimension: number | null): string | null {
  if (!buf || buf.length === 0 || buf.length % 4 !== 0) return null;
  const floatCount = buf.length / 4;
  if (dimension !== null && floatCount !== dimension) return null;
  const floats: number[] = [];
  for (let i = 0; i < buf.length; i += 4) floats.push(buf.readFloatLE(i));
  return "[" + floats.join(",") + "]";
}

/** Live width of pai_chunks.embedding (vector(N)), read once per run. Null if the column type can't be parsed. */
async function resolvePaiChunksEmbeddingDimension(pool: Pool): Promise<number | null> {
  const r = await pool.query<{ type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS type
     FROM pg_attribute
     WHERE attrelid = 'pai_chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`
  );
  const m = /vector\((\d+)\)/.exec(r.rows[0]?.type ?? "");
  return m ? parseInt(m[1], 10) : null;
}

async function copyMemoryFilesAndChunks(
  sqlite: Database,
  pool: Pool,
  dryRun: boolean,
  tables: TableReport[],
  embeddingDimension: number | null
): Promise<string> {
  type FileRow = { project_id: number; path: string; source: string; tier: string; hash: string; mtime: number; size: number };
  type ChunkRow = {
    id: string; project_id: number; source: string; tier: string; path: string;
    start_line: number; end_line: number; hash: string; text: string; updated_at: number;
    embedding: Buffer | null;
  };

  const fileRows = sqlite.prepare("SELECT * FROM memory_files").all() as FileRow[];
  const fileKey = (r: { project_id: number; path: string }) => `${r.project_id}:${r.path}`;

  const pgFileKeys = await pool.query<{ k: string }>("SELECT project_id::text || ':' || path AS k FROM pai_files");
  const pgFileKeySet = new Set(pgFileKeys.rows.map((r) => r.k));
  const missingFiles = fileRows.filter((r) => !pgFileKeySet.has(fileKey(r)));
  const missingFileKeySet = new Set(missingFiles.map(fileKey));

  const allChunkRows = sqlite.prepare("SELECT * FROM memory_chunks").all() as ChunkRow[];
  const chunksToCopy = allChunkRows.filter((c) => missingFileKeySet.has(fileKey(c)));

  let filesCopied = 0;
  let chunksCopied = 0;
  let chunksWithEmbedding = 0;
  let chunksWithoutEmbedding = 0;

  if (!dryRun && missingFiles.length > 0) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const f of missingFiles) {
        const r = await client.query(
          `INSERT INTO pai_files (project_id, path, source, tier, hash, mtime, size)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id, path) DO NOTHING`,
          [f.project_id, f.path, f.source, f.tier, f.hash, f.mtime, f.size]
        );
        filesCopied += r.rowCount ?? 0;
      }
      for (const c of chunksToCopy) {
        const vec = blobToVectorLiteral(c.embedding, embeddingDimension);
        if (vec) chunksWithEmbedding++;
        else chunksWithoutEmbedding++;
        const r = await client.query(
          `INSERT INTO pai_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.project_id, c.source, c.tier, c.path, c.start_line, c.end_line, c.hash, c.text.replace(/\0/g, ""), c.updated_at, vec]
        );
        chunksCopied += r.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    for (const c of chunksToCopy) {
      if (blobToVectorLiteral(c.embedding, embeddingDimension)) chunksWithEmbedding++;
      else chunksWithoutEmbedding++;
    }
  }

  const pgFileKeysAfter = dryRun
    ? pgFileKeys
    : await pool.query<{ k: string }>("SELECT project_id::text || ':' || path AS k FROM pai_files");
  const pgFileKeySetAfter = dryRun ? pgFileKeySet : new Set(pgFileKeysAfter.rows.map((r) => r.k));
  const missingFilesAfter = fileRows.filter((r) => !pgFileKeySetAfter.has(fileKey(r))).length;

  tables.push({
    table: "memory_files -> pai_files",
    sqliteRows: fileRows.length,
    postgresRowsBefore: pgFileKeySet.size,
    copied: dryRun ? 0 : filesCopied,
    missingAfter: dryRun ? missingFiles.length : missingFilesAfter,
  });

  const pgChunkCountBefore = await countRows(pool, "SELECT COUNT(*)::text AS n FROM pai_chunks");
  let missingChunksAfter = 0;
  if (!dryRun) {
    const pgChunkIds = await pool.query<{ id: string }>(
      "SELECT id FROM pai_chunks WHERE id = ANY($1)",
      [chunksToCopy.map((c) => c.id)]
    );
    const pgChunkIdSet = new Set(pgChunkIds.rows.map((r) => r.id));
    missingChunksAfter = chunksToCopy.filter((c) => !pgChunkIdSet.has(c.id)).length;
  } else {
    missingChunksAfter = chunksToCopy.length;
  }

  tables.push({
    table: "memory_chunks -> pai_chunks",
    sqliteRows: allChunkRows.length,
    postgresRowsBefore: pgChunkCountBefore,
    copied: dryRun ? 0 : chunksCopied,
    missingAfter: missingChunksAfter,
  });

  return `memory_chunks: ${chunksToCopy.length} chunk(s) eligible for copy under missing paths — ` +
    `${chunksWithEmbedding} copied with embedding, ${chunksWithoutEmbedding} copied without ` +
    `(dimension mismatch, re-embedded by the daemon).`;
}

// ---------------------------------------------------------------------------
// Vault tables (vault_files, vault_aliases, vault_links, vault_name_index,
// vault_health) — legacy SQLite tables from pre-Postgres-vault installs.
// Migrated only if the SQLite db still physically has them.
// ---------------------------------------------------------------------------

function sqliteHasTable(sqlite: Database, table: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

async function copyVaultTables(sqlite: Database, pool: Pool, dryRun: boolean, tables: TableReport[]): Promise<void> {
  type Row = Record<string, unknown>;
  const all = (table: string): Row[] => sqlite.prepare(`SELECT * FROM ${table}`).all() as Row[];

  if (sqliteHasTable(sqlite, "vault_files")) {
    tables.push(
      await copyByKey<Row>(pool, dryRun, {
        table: "vault_files",
        sqliteRows: all("vault_files"),
        keyFn: (r) => String(r.vault_path),
        pgKeySql: "SELECT vault_path AS k FROM vault_files",
        insertSql: `INSERT INTO vault_files (vault_path, inode, device, hash, title, indexed_at)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (vault_path) DO NOTHING`,
        paramsFn: (r) => [r.vault_path, r.inode, r.device, r.hash, r.title, r.indexed_at],
      })
    );
  }

  if (sqliteHasTable(sqlite, "vault_aliases")) {
    tables.push(
      await copyByKey<Row>(pool, dryRun, {
        table: "vault_aliases",
        sqliteRows: all("vault_aliases"),
        keyFn: (r) => String(r.vault_path),
        pgKeySql: "SELECT vault_path AS k FROM vault_aliases",
        insertSql: `INSERT INTO vault_aliases (vault_path, canonical_path, inode, device)
           VALUES ($1,$2,$3,$4) ON CONFLICT (vault_path) DO NOTHING`,
        paramsFn: (r) => [r.vault_path, r.canonical_path, r.inode, r.device],
      })
    );
  }

  if (sqliteHasTable(sqlite, "vault_links")) {
    tables.push(
      await copyByKey<Row>(pool, dryRun, {
        table: "vault_links",
        sqliteRows: all("vault_links"),
        keyFn: (r) => `${r.source_path}\u0001${r.target_raw}\u0001${r.line_number}`,
        pgKeySql: "SELECT source_path || chr(1) || target_raw || chr(1) || line_number::text AS k FROM vault_links",
        insertSql: `INSERT INTO vault_links (source_path, target_raw, target_path, link_type, line_number)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_path, target_raw, line_number) DO NOTHING`,
        paramsFn: (r) => [r.source_path, r.target_raw, r.target_path, r.link_type, r.line_number],
      })
    );
  }

  if (sqliteHasTable(sqlite, "vault_name_index")) {
    tables.push(
      await copyByKey<Row>(pool, dryRun, {
        table: "vault_name_index",
        sqliteRows: all("vault_name_index"),
        keyFn: (r) => `${r.name}\u0001${r.vault_path}`,
        pgKeySql: "SELECT name || chr(1) || vault_path AS k FROM vault_name_index",
        insertSql: `INSERT INTO vault_name_index (name, vault_path) VALUES ($1,$2) ON CONFLICT (name, vault_path) DO NOTHING`,
        paramsFn: (r) => [r.name, r.vault_path],
      })
    );
  }

  if (sqliteHasTable(sqlite, "vault_health")) {
    tables.push(
      await copyByKey<Row>(pool, dryRun, {
        table: "vault_health",
        sqliteRows: all("vault_health"),
        keyFn: (r) => String(r.vault_path),
        pgKeySql: "SELECT vault_path AS k FROM vault_health",
        insertSql: `INSERT INTO vault_health (vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (vault_path) DO NOTHING`,
        paramsFn: (r) => [r.vault_path, r.inbound_count, r.outbound_count, r.dead_link_count, r.is_orphan, r.computed_at],
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Spot check: 20 random rows per key-preserving table, field-by-field
// ---------------------------------------------------------------------------

export interface SpotCheckMismatch {
  table: string;
  key: string;
  field: string;
  sqliteValue: unknown;
  postgresValue: unknown;
}

/**
 * For kg_entities and projects (the two tables §4 step 6 calls out by name):
 * pull up to 20 random rows from SQLite and confirm every field matches the
 * Postgres row exactly. Returns the mismatches found (empty = all match).
 */
async function spotCheck(sqlite: Database, pool: Pool, table: string, keyCol: string): Promise<SpotCheckMismatch[]> {
  const sample = sqlite
    .prepare(`SELECT * FROM ${table} ORDER BY RANDOM() LIMIT 20`)
    .all() as Array<Record<string, unknown>>;
  const mismatches: SpotCheckMismatch[] = [];

  for (const row of sample) {
    const key = row[keyCol];
    const r = await pool.query(`SELECT * FROM ${table} WHERE ${keyCol} = $1`, [key]);
    const pgRow = r.rows[0] as Record<string, unknown> | undefined;
    if (!pgRow) {
      mismatches.push({ table, key: String(key), field: keyCol, sqliteValue: key, postgresValue: undefined });
      continue;
    }
    for (const field of Object.keys(row)) {
      if (!(field in pgRow)) continue;
      const a = row[field];
      const b = pgRow[field];
      // BIGINT columns come back as strings from pg; normalise before compare.
      const normA = typeof a === "number" ? String(a) : a;
      const normB = typeof b === "number" ? String(b) : b;
      if (String(normA ?? "") !== String(normB ?? "")) {
        mismatches.push({ table, key: String(key), field, sqliteValue: a, postgresValue: b });
      }
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function refused(reason: string, dryRun: boolean): MigrationResult {
  return { ok: false, dryRun, refused: reason, tables: [], embeddingsNote: "" };
}

export async function migrateToPostgres(opts: MigrateOptions = {}): Promise<MigrationResult> {
  const config = loadConfig();
  const container = opts.container ?? DEFAULT_CONTAINER;
  const dryRun = opts.dryRun ?? false;

  if (!opts.skipConfigGate && config.storageBackend !== "postgres") {
    return refused('config storageBackend is not "postgres" — set it first, then re-run', dryRun);
  }
  const pgConfig: PostgresConfig = opts.pgConfig ?? config.postgres ?? {};

  const mountCheck = checkBindMount(container);
  if (!mountCheck.ok) return refused(mountCheck.reason, dryRun);

  // Read-only counting cannot lose a concurrent write the way a real copy
  // can (see docs/design/postgres-only.md §6) — only the write path needs
  // the daemon stopped.
  if (!dryRun && !opts.allowRunning) {
    const daemonCheck = await checkDaemonNotRunning(opts.socketPath ?? config.socketPath);
    if (!daemonCheck.ok) return refused(daemonCheck.reason, dryRun);
  }

  const sqliteFederationPath = opts.sqliteFederationPath ?? federationDbPath();
  const sqliteRegistryPath = opts.sqliteRegistryPath ?? registryDbPath();
  if (!existsSync(sqliteFederationPath)) {
    return refused(`federation SQLite db not found at ${sqliteFederationPath}`, dryRun);
  }
  if (!existsSync(sqliteRegistryPath)) {
    return refused(`registry SQLite db not found at ${sqliteRegistryPath}`, dryRun);
  }

  let dumpPath: string | undefined;
  if (!dryRun && !opts.skipDump) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    dumpPath = paiHomePath("backups", `pg-pre-migration-${stamp}.dump`);
    const dump = pgDump(container, pgConfig, dumpPath);
    if (!dump.ok) return refused(dump.reason, dryRun);
  }

  // Idempotent DDL only (CREATE TABLE/DATABASE IF NOT EXISTS) — safe before a
  // dry-run count too, since it never touches existing rows. Every other
  // entry point (factory.ts) already calls this unconditionally.
  const { PostgresBackend } = await import("./postgres.js");
  await PostgresBackend.ensureDatabase(pgConfig);

  const sqlite = new BetterSqlite3(sqliteFederationPath, { readonly: true });
  const registrySqlite =
    sqliteRegistryPath === sqliteFederationPath ? sqlite : new BetterSqlite3(sqliteRegistryPath, { readonly: true });
  const pool = new PgPool({
    connectionString: resolvePgConnectionString(pgConfig),
    max: 4,
    connectionTimeoutMillis: pgConfig.connectionTimeoutMs ?? 5000,
  });

  const tables: TableReport[] = [];
  let embeddingsNote = "";

  try {
    await copyRegistryTables(registrySqlite, pool, dryRun, tables);
    await copyKgEntities(sqlite, pool, dryRun, tables);
    const embeddingDimension = await resolvePaiChunksEmbeddingDimension(pool);
    embeddingsNote = await copyMemoryFilesAndChunks(sqlite, pool, dryRun, tables, embeddingDimension);
    await copyVaultTables(sqlite, pool, dryRun, tables);

    let spotCheckOk = true;
    if (!dryRun) {
      const kgMismatches = await spotCheck(sqlite, pool, "kg_entities", "entity_id");
      const projectMismatches = await spotCheck(registrySqlite, pool, "projects", "id");
      const mismatches = [...kgMismatches, ...projectMismatches];
      spotCheckOk = mismatches.length === 0;
      if (!spotCheckOk) {
        embeddingsNote +=
          ` SPOT CHECK FAILED: ${mismatches.length} field mismatch(es) — ` +
          mismatches.slice(0, 5).map((m) => `${m.table}.${m.key}.${m.field}`).join(", ");
      }
    }

    // A dry run's "missing" count is the whole point of running it — it is
    // not a failure. Only a real copy is expected to reach zero missing.
    const missingTotal = tables.reduce((n, t) => n + t.missingAfter, 0);
    return {
      ok: dryRun ? true : missingTotal === 0 && spotCheckOk,
      dryRun,
      dumpPath,
      tables,
      embeddingsNote,
    };
  } finally {
    sqlite.close();
    if (registrySqlite !== sqlite) registrySqlite.close();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export function renderReport(result: MigrationResult): string {
  const lines: string[] = [];
  if (result.refused) {
    lines.push(`REFUSED: ${result.refused}`);
    return lines.join("\n");
  }

  lines.push(result.dryRun ? "Dry run — no writes, no dump." : "Migration complete.");
  if (result.dumpPath) lines.push(`Rollback dump: ${result.dumpPath}`);
  lines.push("");
  const header = ["table", "sqlite_rows", "postgres_before", "copied", "missing_after"];
  lines.push(header.join("\t"));
  for (const t of result.tables) {
    lines.push([t.table, t.sqliteRows, t.postgresRowsBefore, t.copied, t.missingAfter].join("\t"));
  }
  lines.push("");
  lines.push(result.embeddingsNote);
  lines.push("");
  if (result.dryRun) {
    lines.push("Dry run complete — \"missing_after\" is how many rows a real run would copy.");
  } else {
    lines.push(result.ok ? "OK: no missing rows." : "FAILED: missing rows after copy — see table above.");
  }
  return lines.join("\n");
}
