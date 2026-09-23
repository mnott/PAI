/**
 * SQLiteBackend — wraps the existing better-sqlite3 federation.db
 * behind the StorageBackend interface.
 *
 * This is a thin adapter.  The heavy lifting is all in the existing
 * memory/indexer.ts and memory/search.ts code; we just provide a
 * backend-agnostic surface so the daemon and tools can call either
 * SQLite or Postgres transparently.
 */

import type { Database } from "better-sqlite3";
import type {
  StorageBackend, ChunkRow, FileRow, FederationStats,
  MemorySourcesReport, FindTunnelsOptions, FindTunnelsResult,
  KgStats, ObservationRow, ObservationWithCwd, StoreObservationInput, QueryObservationsOptions,
  ObservationStats, SessionSummaryRow, StoreSessionSummaryInput,
  SkillTelemetryRow, RecordSkillInvocationInput, QuerySkillTelemetryOptions,
} from "./interface.js";
import type { SearchResult, SearchOptions } from "../memory/search.js";
import type { KgEntity, KgEntityUpsertParams } from "../memory/kg-entity.js";
import type { KgAddParams, KgQueryParams, KgTriple, KgContradiction } from "../memory/kg.js";
import type { IndexResult } from "../memory/indexer/types.js";
import type { RegistryBackend } from "./registry-interface.js";
import { indexAllSqlite } from "./sqlite/indexer.js";
import { findTunnelsSqlite } from "./sqlite/tunnels.js";
import { getMemorySourcesReportSqlite } from "./sqlite/sources.js";
import { searchMemory, searchMemorySemantic, touchChunksLastAccessed } from "./sqlite/search.js";
import {
  upsertKgEntitySqlite,
  findKgEntitySqlite,
  listKgEntitiesSqlite,
  updateEntityFeedbackWeightSqlite,
} from "./sqlite/kg-entity.js";

export class SQLiteBackend implements StorageBackend {
  readonly backendType = "sqlite" as const;
  readonly supportsPostgresFeatures = false;

  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Expose the raw better-sqlite3 Database handle. Storage-internal only —
   * used by db-admin.ts for `pai db query|tables|schema` (the one place
   * outside this class allowed to reach for it). Every other operation must
   * be a StorageBackend method; nothing outside src/storage/ may call this.
   */
  getRawDb(): Database {
    return this.db;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  async getStats(): Promise<FederationStats> {
    const files = (
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_files").get() as { n: number }
    ).n;
    const chunks = (
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }
    ).n;
    return { files, chunks };
  }

  async getProjectStats(projectId: number): Promise<FederationStats> {
    const files = (
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_files WHERE project_id = ?").get(projectId) as { n: number }
    ).n;
    const chunks = (
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE project_id = ?").get(projectId) as { n: number }
    ).n;
    return { files, chunks };
  }

  // -------------------------------------------------------------------------
  // File tracking
  // -------------------------------------------------------------------------

  async getFileHash(projectId: number, path: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT hash FROM memory_files WHERE project_id = ? AND path = ?")
      .get(projectId, path) as { hash: string } | undefined;
    return row?.hash;
  }

  async upsertFile(file: FileRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memory_files (project_id, path, source, tier, hash, mtime, size)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, path) DO UPDATE SET
           source = excluded.source,
           tier   = excluded.tier,
           hash   = excluded.hash,
           mtime  = excluded.mtime,
           size   = excluded.size`
      )
      .run(file.projectId, file.path, file.source, file.tier, file.hash, file.mtime, file.size);
  }

  // -------------------------------------------------------------------------
  // Chunk management
  // -------------------------------------------------------------------------

  async getChunkIds(projectId: number, path: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT id FROM memory_chunks WHERE project_id = ? AND path = ?")
      .all(projectId, path) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async deleteChunksForFile(projectId: number, path: string): Promise<void> {
    const ids = await this.getChunkIds(projectId, path);
    const deleteFts = this.db.prepare("DELETE FROM memory_fts WHERE id = ?");
    const deleteChunks = this.db.prepare(
      "DELETE FROM memory_chunks WHERE project_id = ? AND path = ?"
    );
    this.db.transaction(() => {
      for (const id of ids) {
        deleteFts.run(id);
      }
      deleteChunks.run(projectId, path);
    })();
  }

  async insertChunks(chunks: ChunkRow[]): Promise<void> {
    if (chunks.length === 0) return;

    const insertChunk = this.db.prepare(
      `INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memory_fts (text, id, project_id, path, source, tier, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.transaction(() => {
      for (const c of chunks) {
        insertChunk.run(
          c.id,
          c.projectId,
          c.source,
          c.tier,
          c.path,
          c.startLine,
          c.endLine,
          c.hash,
          c.text,
          c.updatedAt
        );
        insertFts.run(
          c.text,
          c.id,
          c.projectId,
          c.path,
          c.source,
          c.tier,
          c.startLine,
          c.endLine
        );
      }
    })();
  }

  async getDistinctChunkPaths(projectId: number): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT path FROM memory_chunks WHERE project_id = ?")
      .all(projectId) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  async deletePaths(projectId: number, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const deleteFts = this.db.prepare("DELETE FROM memory_fts WHERE id = ?");
    const deleteChunks = this.db.prepare(
      "DELETE FROM memory_chunks WHERE project_id = ? AND path = ?"
    );
    const deleteFile = this.db.prepare(
      "DELETE FROM memory_files WHERE project_id = ? AND path = ?"
    );
    this.db.transaction(() => {
      for (const path of paths) {
        const ids = this.db
          .prepare("SELECT id FROM memory_chunks WHERE project_id = ? AND path = ?")
          .all(projectId, path) as Array<{ id: string }>;
        for (const { id } of ids) {
          deleteFts.run(id);
        }
        deleteChunks.run(projectId, path);
        deleteFile.run(projectId, path);
      }
    })();
  }

  async getUnembeddedChunkIds(
    projectId?: number,
    limit?: number,
    after?: { projectId: number; id: string } | null,
  ): Promise<Array<{ id: string; text: string; project_id: number; path: string }>> {
    const conditions = ["embedding IS NULL"];
    const params: (string | number)[] = [];

    if (projectId !== undefined) {
      conditions.push("project_id = ?");
      params.push(projectId);
    }

    // Once paginating, the priority ORDER BY below no longer applies — pages
    // must be ordered by the same (project_id, id) the cursor seeks on.
    const paginating = after !== undefined;
    if (after) {
      conditions.push("(project_id > ? OR (project_id = ? AND id > ?))");
      params.push(after.projectId, after.projectId, after.id);
    }

    const where = "WHERE " + conditions.join(" AND ");
    // Prioritize real knowledge notes over PAI session/job-search noise.
    // CASE expression assigns lower priority numbers to knowledge paths.
    const orderBy = paginating
      ? "project_id, id"
      : `CASE
          WHEN path LIKE '🧠 Ideaverse/%' THEN 0
          WHEN path LIKE 'Z - Zettelkasten/%' THEN 0
          WHEN path LIKE '💼 Business/%' THEN 0
          WHEN path LIKE '📆 Meetings/%' THEN 1
          WHEN path LIKE '💡 Insights/%' THEN 1
          WHEN path LIKE '👨‍💻 People/%' THEN 1
          WHEN path LIKE 'University/%' THEN 1
          WHEN path LIKE 'Copilot/%' THEN 1
          WHEN path LIKE '🗓️ Daily Notes/%' THEN 2
          WHEN path LIKE 'PAI/%' THEN 3
          WHEN path LIKE '09-job-search/%' THEN 4
          WHEN path LIKE 'seriousletter/%' THEN 4
          WHEN path LIKE 'Attachments/%' THEN 5
          ELSE 2
        END, id`;
    const rows = this.db
      .prepare(`SELECT id, text, project_id, path FROM memory_chunks ${where}
        ORDER BY ${orderBy}${limit !== undefined ? " LIMIT ?" : ""}`)
      .all(...params, ...(limit !== undefined ? [limit] : [])) as Array<{ id: string; text: string; project_id: number; path: string }>;
    return rows;
  }

  async updateEmbedding(chunkId: string, embedding: Buffer): Promise<void> {
    this.db
      .prepare("UPDATE memory_chunks SET embedding = ? WHERE id = ?")
      .run(embedding, chunkId);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async searchKeyword(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    return searchMemory(this.db, query, opts);
  }

  async searchSemantic(queryEmbedding: Float32Array, opts?: SearchOptions): Promise<SearchResult[]> {
    return searchMemorySemantic(this.db, queryEmbedding, opts);
  }

  // -------------------------------------------------------------------------
  // Vault operations — not supported on SQLite backend (use Postgres)
  // -------------------------------------------------------------------------

  private vaultNotSupported(): never {
    throw new Error("Vault operations require the Postgres backend");
  }

  async upsertVaultFile(): Promise<void> { this.vaultNotSupported(); }
  async deleteVaultFile(): Promise<void> { this.vaultNotSupported(); }
  async getVaultFile(): Promise<null> { this.vaultNotSupported(); }
  async getVaultFileByInode(): Promise<null> { this.vaultNotSupported(); }
  async getAllVaultFiles(): Promise<never[]> { this.vaultNotSupported(); }
  async getRecentVaultFiles(): Promise<never[]> { this.vaultNotSupported(); }
  async countVaultFiles(): Promise<number> { this.vaultNotSupported(); }
  async upsertVaultAliases(): Promise<void> { this.vaultNotSupported(); }
  async deleteVaultAliases(): Promise<void> { this.vaultNotSupported(); }
  async replaceLinksForSources(): Promise<void> { this.vaultNotSupported(); }
  async getLinksFromSource(): Promise<never[]> { this.vaultNotSupported(); }
  async getLinksToTarget(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultLinkGraph(): Promise<never[]> { this.vaultNotSupported(); }
  async upsertVaultHealth(): Promise<void> { this.vaultNotSupported(); }
  async getVaultHealth(): Promise<null> { this.vaultNotSupported(); }
  async getOrphans(): Promise<never[]> { this.vaultNotSupported(); }
  async getDeadLinks(): Promise<never[]> { this.vaultNotSupported(); }
  async upsertNameIndex(): Promise<void> { this.vaultNotSupported(); }
  async replaceNameIndex(): Promise<void> { this.vaultNotSupported(); }
  async resolveVaultName(): Promise<never[]> { this.vaultNotSupported(); }
  async searchVaultNameIndex(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultFilesByPaths(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultFilesByPathsAfter(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultLinksFromPaths(): Promise<never[]> { this.vaultNotSupported(); }
  async getChunksWithEmbeddings(): Promise<never[]> { this.vaultNotSupported(); }
  async getChunksForPath(): Promise<never[]> { this.vaultNotSupported(); }
  async searchChunksByText(): Promise<never[]> { this.vaultNotSupported(); }
  async countVaultFilesWithPrefix(): Promise<number> { this.vaultNotSupported(); }
  async countVaultFilesAfter(): Promise<number> { this.vaultNotSupported(); }
  async countVaultLinksWithPrefix(): Promise<number> { this.vaultNotSupported(); }
  async countVaultLinksAfter(): Promise<number> { this.vaultNotSupported(); }
  async getDeadLinksWithLineNumbers(): Promise<never[]> { this.vaultNotSupported(); }
  async getDeadLinksWithPrefix(): Promise<never[]> { this.vaultNotSupported(); }
  async getDeadLinksAfter(): Promise<never[]> { this.vaultNotSupported(); }
  async getOrphansWithPrefix(): Promise<never[]> { this.vaultNotSupported(); }
  async getOrphansAfter(): Promise<never[]> { this.vaultNotSupported(); }
  async getLowConnectivity(): Promise<never[]> { this.vaultNotSupported(); }
  async getLowConnectivityWithPrefix(): Promise<never[]> { this.vaultNotSupported(); }
  async getLowConnectivityAfter(): Promise<never[]> { this.vaultNotSupported(); }
  async getAllVaultFilePaths(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultFilePathsWithPrefix(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultFilePathsAfter(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultLinkEdges(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultLinkEdgesWithPrefix(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultLinkEdgesAfter(): Promise<never[]> { this.vaultNotSupported(); }
  async getVaultAlias(): Promise<null> { this.vaultNotSupported(); }

  // -------------------------------------------------------------------------
  // Knowledge-graph entities (kg_entities) — wraps storage/sqlite/kg-entity.ts
  // -------------------------------------------------------------------------

  async upsertKgEntity(params: KgEntityUpsertParams): Promise<string> {
    return upsertKgEntitySqlite(this.db, params);
  }

  async findKgEntity(name: string, tenantId = "default"): Promise<KgEntity | null> {
    return findKgEntitySqlite(this.db, name, tenantId);
  }

  async listKgEntities(tenantId = "default", type?: string, limit = 100): Promise<KgEntity[]> {
    return listKgEntitiesSqlite(this.db, tenantId, type, limit);
  }

  async updateEntityFeedbackWeight(entityId: string, normalizedRating: number, alpha = 0.1): Promise<void> {
    return updateEntityFeedbackWeightSqlite(this.db, entityId, normalizedRating, alpha);
  }

  // -------------------------------------------------------------------------
  // Chunk feedback / access tracking
  // -------------------------------------------------------------------------

  async getChunksForFeedback(chunkIds: string[]): Promise<Array<{ id: string; text: string; relevanceScore: number | null }>> {
    if (chunkIds.length === 0) return [];
    const placeholders = chunkIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT id, text, relevance_score FROM memory_chunks WHERE id IN (${placeholders})`)
      .all(...chunkIds) as Array<{ id: string; text: string; relevance_score: number | null }>;
    return rows.map((r) => ({ id: r.id, text: r.text, relevanceScore: r.relevance_score }));
  }

  async updateChunkRelevanceScore(chunkId: string, score: number): Promise<void> {
    this.db.prepare("UPDATE memory_chunks SET relevance_score = ? WHERE id = ?").run(score, chunkId);
  }

  async touchChunksLastAccessed(chunkIds: string[]): Promise<void> {
    touchChunksLastAccessed(this.db, chunkIds);
  }

  // -------------------------------------------------------------------------
  // Global indexing
  // -------------------------------------------------------------------------

  async indexAll(registry: RegistryBackend): Promise<{ projects: number; result: IndexResult }> {
    return indexAllSqlite(this.db, registry);
  }

  // -------------------------------------------------------------------------
  // Cross-project concept tunnels
  // -------------------------------------------------------------------------

  async findTunnels(registry: RegistryBackend, options?: FindTunnelsOptions): Promise<FindTunnelsResult> {
    return findTunnelsSqlite(this.db, registry, options);
  }

  // -------------------------------------------------------------------------
  // Memory sources report
  // -------------------------------------------------------------------------

  async getMemorySourcesReport(): Promise<MemorySourcesReport> {
    return getMemorySourcesReportSqlite(this.db);
  }

  // -------------------------------------------------------------------------
  // Temporal knowledge graph / observations / skill telemetry — not
  // supported on SQLite (kg_triples, pai_observations, pai_session_summaries,
  // pai_skill_telemetry only exist in the Postgres schema).
  // -------------------------------------------------------------------------

  private postgresOnly(feature: string): never {
    throw new Error(`${feature} is not supported on the sqlite backend — set "storageBackend": "postgres" in the daemon config`);
  }

  async addKgTriple(): Promise<KgTriple> { this.postgresOnly("kg_triples"); }
  async queryKgTriples(): Promise<KgTriple[]> { this.postgresOnly("kg_triples"); }
  async invalidateKgTriple(): Promise<void> { this.postgresOnly("kg_triples"); }
  async getKgContradictions(): Promise<KgContradiction[]> { this.postgresOnly("kg_triples"); }
  async getKgStats(): Promise<KgStats> { this.postgresOnly("kg_triples"); }

  async storeObservation(): Promise<number | null> { this.postgresOnly("observations"); }
  async storeObservationWithProject(): Promise<number | null> { this.postgresOnly("observations"); }
  async queryObservations(): Promise<ObservationRow[]> { this.postgresOnly("observations"); }
  async queryRecentObservations(): Promise<ObservationRow[]> { this.postgresOnly("observations"); }
  async querySessionObservations(): Promise<ObservationRow[]> { this.postgresOnly("observations"); }
  async getObservationStats(): Promise<ObservationStats> { this.postgresOnly("observations"); }
  async getObservationTypesForPaths(): Promise<Map<string, Record<string, number>>> { return new Map(); }
  async storeSessionSummary(): Promise<void> { this.postgresOnly("session summaries"); }
  async queryRecentSummaries(): Promise<SessionSummaryRow[]> { this.postgresOnly("session summaries"); }
  async recordSkillInvocation(): Promise<void> { this.postgresOnly("skill telemetry"); }
  async querySkillTelemetry(): Promise<SkillTelemetryRow[]> { this.postgresOnly("skill telemetry"); }

  // -------------------------------------------------------------------------
  // File-path rename (session cleanup: moving Notes/*.md into YYYY/MM/)
  // -------------------------------------------------------------------------

  async countFilesWithPaths(paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const placeholders = paths.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memory_files WHERE path IN (${placeholders})`)
      .get(...paths) as { n: number };
    return row.n;
  }

  async renameFilePaths(moves: Array<{ oldPath: string; newPath: string }>): Promise<number> {
    if (moves.length === 0) return 0;
    const updateFiles = this.db.prepare("UPDATE memory_files SET path = ? WHERE path = ?");
    const updateChunks = this.db.prepare("UPDATE memory_chunks SET path = ? WHERE path = ?");
    let filesUpdated = 0;
    this.db.transaction(() => {
      for (const { oldPath, newPath } of moves) {
        const r = updateFiles.run(newPath, oldPath);
        filesUpdated += r.changes;
        updateChunks.run(newPath, oldPath);
      }
    })();
    return filesUpdated;
  }
}
