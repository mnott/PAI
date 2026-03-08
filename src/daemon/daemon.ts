/**
 * daemon.ts — The persistent PAI Daemon
 *
 * Provides shared database access, tool dispatch, and periodic index scheduling
 * for multiple concurrent Claude Code sessions via a Unix Domain Socket.
 *
 * Architecture:
 *   MCP shims (Claude sessions) → Unix socket → PAI Daemon
 *                                                   ├── registry.db (shared, WAL, always SQLite)
 *                                                   ├── federation (SQLite or Postgres/pgvector)
 *                                                   ├── Embedding model (singleton)
 *                                                   └── Index scheduler (periodic)
 *
 * IPC protocol: NDJSON over Unix Domain Socket
 *
 * Request  (shim → daemon):
 *   { "id": "uuid", "method": "tool_name_or_special", "params": {} }
 *
 * Response (daemon → shim):
 *   { "id": "uuid", "ok": true, "result": <any> }
 *   { "id": "uuid", "ok": false, "error": "message" }
 *
 * Special methods:
 *   status     — Return daemon status (uptime, index state, db stats)
 *   index_now  — Trigger immediate index run (non-blocking)
 *
 * All other methods are dispatched to the corresponding PAI tool function.
 *
 * Design notes:
 * - Registry stays in SQLite (small, simple metadata).
 * - Federation backend is configurable: SQLite (default) or Postgres/pgvector.
 * - Auto-fallback: if Postgres is configured but unavailable, falls back to SQLite.
 * - Index writes guarded by indexInProgress flag (not a mutex — index is idempotent).
 * - Embedding model loaded lazily on first semantic/hybrid request, then kept alive.
 * - Scheduler runs indexAll() every indexIntervalSecs (default 5 minutes).
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer, connect, Socket, Server } from "node:net";
import { setPriority, homedir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "../registry/db.js";
import type { Database } from "better-sqlite3";
import { indexAll } from "../memory/indexer.js";
import {
  toolMemorySearch,
  toolMemoryGet,
  toolProjectInfo,
  toolProjectList,
  toolSessionList,
  toolRegistrySearch,
  toolProjectDetect,
  toolProjectHealth,
  toolProjectTodo,
  toolSessionRoute,
} from "../mcp/tools.js";
import { detectTopicShift } from "../topics/detector.js";
import type { PaiDaemonConfig } from "./config.js";
import { createStorageBackend } from "../storage/factory.js";
import type { StorageBackend } from "../storage/interface.js";
import { configureEmbeddingModel } from "../memory/embeddings.js";
import type { NotificationConfig, NotificationMode } from "../notifications/types.js";
import {
  loadNotificationConfig,
  patchNotificationConfig,
} from "../notifications/config.js";
import { routeNotification } from "../notifications/router.js";
import {
  ensureObservationTables,
  storeObservation,
  queryObservations,
  queryRecentObservations,
  storeSessionSummary,
} from "../observations/store.js";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

interface IpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

let registryDb: ReturnType<typeof openRegistry>;
let storageBackend: StorageBackend;
let daemonConfig: PaiDaemonConfig;
let startTime = Date.now();

/**
 * Always-available SQLite handle to federation.db for vault and graph tools.
 * When the primary backend is SQLite, this is the same DB handle as storageBackend.
 * When the primary backend is Postgres, this is a separate read-only SQLite connection.
 * Null only if federation.db could not be opened (non-fatal — tools will error gracefully).
 */
let vaultDb: Database | null = null;

/** True when vaultDb was opened separately (Postgres primary) and must be closed at shutdown. */
let vaultDbOwnedSeparately = false;

// Index scheduler state
let indexInProgress = false;
let lastIndexTime = 0;
let indexSchedulerTimer: ReturnType<typeof setInterval> | null = null;

// Embed scheduler state
let embedInProgress = false;
let lastEmbedTime = 0;
let embedSchedulerTimer: ReturnType<typeof setInterval> | null = null;

// Vault index scheduler state
let vaultIndexInProgress = false;
let lastVaultIndexTime = 0;

// ---------------------------------------------------------------------------
// Notification state
// ---------------------------------------------------------------------------

/** Mutable notification config — loaded from disk at startup, patchable at runtime */
let notificationConfig: NotificationConfig;

// ---------------------------------------------------------------------------
// Graceful shutdown flag
// ---------------------------------------------------------------------------

/**
 * Set to true when a SIGTERM/SIGINT is received so that long-running loops
 * (embed, index) can detect the signal and exit their inner loops before the
 * pool/backend is closed.  Checked by embedChunksWithBackend() via the
 * `shouldStop` callback passed from runEmbed().
 */
let shutdownRequested = false;

// ---------------------------------------------------------------------------
// Index scheduler
// ---------------------------------------------------------------------------

/**
 * Run a full index pass. Guards against overlapping runs with indexInProgress.
 * Called both by the scheduler and by the index_now IPC method.
 *
 * NOTE: We pass the raw SQLite federation DB to indexAll() for SQLite backend,
 * or skip and use the backend interface for Postgres.  The indexer currently
 * uses better-sqlite3 directly; it will be refactored in a future phase.
 * For now, we keep the SQLite indexer path and add a Postgres-aware path.
 */
async function runIndex(): Promise<void> {
  if (indexInProgress) {
    process.stderr.write("[pai-daemon] Index already in progress, skipping.\n");
    return;
  }

  if (embedInProgress) {
    process.stderr.write("[pai-daemon] Embed in progress, deferring index run.\n");
    return;
  }

  indexInProgress = true;
  const t0 = Date.now();

  try {
    process.stderr.write("[pai-daemon] Starting scheduled index run...\n");

    if (storageBackend.backendType === "sqlite") {
      // SQLite: use existing indexAll() which operates on the raw DB handle
      // We need the raw DB — extract it from the SQLite backend
      const { SQLiteBackend } = await import("../storage/sqlite.js");
      if (storageBackend instanceof SQLiteBackend) {
        const db = (storageBackend as SQLiteBackendWithDb).getRawDb();
        const { projects, result } = await indexAll(db, registryDb);
        const elapsed = Date.now() - t0;
        lastIndexTime = Date.now();
        process.stderr.write(
          `[pai-daemon] Index complete: ${projects} projects, ` +
            `${result.filesProcessed} files, ${result.chunksCreated} chunks ` +
            `(${elapsed}ms)\n`
        );
      }
    } else {
      // Postgres: use the backend-aware indexer
      const { indexAllWithBackend } = await import("../memory/indexer-backend.js");
      const { projects, result } = await indexAllWithBackend(storageBackend, registryDb);
      const elapsed = Date.now() - t0;
      lastIndexTime = Date.now();
      process.stderr.write(
        `[pai-daemon] Index complete (postgres): ${projects} projects, ` +
          `${result.filesProcessed} files, ${result.chunksCreated} chunks ` +
          `(${elapsed}ms)\n`
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Index error: ${msg}\n`);
  } finally {
    indexInProgress = false;
  }
}

/**
 * Internal interface for accessing the raw DB from SQLiteBackend.
 * This avoids a circular dep while keeping type safety.
 */
interface SQLiteBackendWithDb {
  getRawDb(): Database;
}

/**
 * Internal interface for accessing the pg.Pool from PostgresBackend.
 * Mirrors SQLiteBackendWithDb — avoids a circular dep while keeping type safety.
 */
interface PostgresBackendWithPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPool?(): any;
}

/**
 * Run a vault index pass. Guards against overlapping runs with vaultIndexInProgress.
 * Skips if no vaultPath is configured, or if project index/embed is in progress.
 * Called both by the scheduler (chained after runIndex) and by the vault_index_now IPC method.
 */
async function runVaultIndex(): Promise<void> {
  // Skip if no vault path configured
  if (!daemonConfig.vaultPath) return;

  if (vaultIndexInProgress) {
    process.stderr.write("[pai-daemon] Vault index already in progress, skipping.\n");
    return;
  }

  // Don't run concurrently with project index or embed
  if (indexInProgress || embedInProgress) {
    process.stderr.write("[pai-daemon] Index/embed in progress, deferring vault index.\n");
    return;
  }

  vaultIndexInProgress = true;
  const t0 = Date.now();

  try {
    process.stderr.write("[pai-daemon] Starting vault index run...\n");

    // Use vaultDb which is always the SQLite federation.db handle regardless
    // of which primary backend (SQLite or Postgres) is active.
    if (!vaultDb) {
      process.stderr.write("[pai-daemon] Vault indexing skipped: vault database (federation.db) is not available.\n");
      return;
    }

    // vaultDb is read-only when primary backend is Postgres — vault indexer writes,
    // so we need write access. When the primary backend is Postgres and vaultDb was
    // opened read-only, we open a separate writable connection for the indexer.
    let indexDb: Database = vaultDb;
    let indexDbOwned = false;
    if (vaultDbOwnedSeparately) {
      // Re-open writable for indexing
      const { openFederation } = await import("../memory/db.js");
      indexDb = openFederation();
      indexDbOwned = true;
    }

    try {
      // Auto-detect vault project ID if not configured.
      // Fall back to synthetic project ID 999 if vault is not in the registry
      // (vault chunks are indexed under project_id=999 by convention).
      let vaultProjectId = daemonConfig.vaultProjectId;
      if (!vaultProjectId) {
        // Look for a project registered at the vault path
        const row = registryDb
          .prepare("SELECT id FROM projects WHERE root_path = ?")
          .get(daemonConfig.vaultPath) as { id: number } | undefined;
        vaultProjectId = row?.id ?? 999;
        if (!row) {
          process.stderr.write("[pai-daemon] Vault not in project registry — using synthetic project ID 999.\n");
        }
      }

      const { indexVault } = await import("../memory/vault-indexer.js");
      const result = await indexVault(indexDb, vaultProjectId, daemonConfig.vaultPath!);
      const elapsed = Date.now() - t0;
      lastVaultIndexTime = Date.now();
      process.stderr.write(
        `[pai-daemon] Vault index complete: ${result.filesIndexed} files, ` +
        `${result.linksExtracted} links, ${result.deadLinksFound} dead, ` +
        `${result.orphansFound} orphans (${elapsed}ms)\n`
      );
    } finally {
      if (indexDbOwned) {
        try { indexDb.close(); } catch { /* ignore */ }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Vault index error: ${msg}\n`);
  } finally {
    vaultIndexInProgress = false;
  }
}

/**
 * Start the periodic index scheduler.
 */
function startIndexScheduler(): void {
  const intervalMs = daemonConfig.indexIntervalSecs * 1_000;

  process.stderr.write(
    `[pai-daemon] Index scheduler: every ${daemonConfig.indexIntervalSecs}s\n`
  );

  // Run an initial index at startup (non-blocking — let the socket come up first)
  setTimeout(() => {
    runIndex()
      .then(() => runVaultIndex())
      .catch((e) => {
        process.stderr.write(`[pai-daemon] Startup index error: ${e}\n`);
      });
  }, 2_000);

  indexSchedulerTimer = setInterval(() => {
    runIndex()
      .then(() => runVaultIndex())
      .catch((e) => {
        process.stderr.write(`[pai-daemon] Scheduled index error: ${e}\n`);
      });
  }, intervalMs);

  // Don't let the interval keep the process alive if all else exits
  if (indexSchedulerTimer.unref) {
    indexSchedulerTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Embed scheduler
// ---------------------------------------------------------------------------

/**
 * Run an embedding pass for all unembedded chunks (Postgres backend only).
 * Guards against overlapping runs with embedInProgress.
 * Skips if an index run is currently in progress to avoid contention.
 */
async function runEmbed(): Promise<void> {
  if (embedInProgress) {
    process.stderr.write("[pai-daemon] Embed already in progress, skipping.\n");
    return;
  }

  // Don't compete with the indexer — it writes new chunks that will need embedding
  if (indexInProgress) {
    process.stderr.write("[pai-daemon] Index in progress, deferring embed pass.\n");
    return;
  }

  // Embedding is only supported on the Postgres backend.
  // The SQLite path uses embedChunks() in indexer.ts directly (manual CLI only).
  if (storageBackend.backendType !== "postgres") {
    return;
  }

  embedInProgress = true;
  const t0 = Date.now();

  try {
    process.stderr.write("[pai-daemon] Starting scheduled embed pass...\n");

    // Build project name map for readable logs
    const projectNames = new Map<number, string>();
    try {
      const rows = registryDb
        .prepare("SELECT id, slug FROM projects WHERE status = 'active'")
        .all() as Array<{ id: number; slug: string }>;
      for (const r of rows) projectNames.set(r.id, r.slug);
    } catch { /* registry unavailable — IDs will be used instead */ }

    const { embedChunksWithBackend } = await import("../memory/indexer-backend.js");
    const count = await embedChunksWithBackend(storageBackend, () => shutdownRequested, projectNames);

    // Also embed vault chunks stored in SQLite federation.db (project_id=999).
    // These are indexed by the vault indexer but are not in Postgres, so the
    // Postgres embed pass above skips them. Open a writable SQLite backend and
    // run a separate embed pass against it.
    let vaultEmbedCount = 0;
    if (daemonConfig.vaultPath) {
      try {
        const { SQLiteBackend } = await import("../storage/sqlite.js");
        const { openFederation } = await import("../memory/db.js");
        const federationDb = openFederation();
        const vaultSqliteBackend = new SQLiteBackend(federationDb);

        // Add vault project name (999 = Obsidian vault) for readable log output
        const vaultProjectNames = new Map(projectNames);
        if (!vaultProjectNames.has(999)) {
          vaultProjectNames.set(999, "obsidian-vault");
        }

        vaultEmbedCount = await embedChunksWithBackend(
          vaultSqliteBackend,
          () => shutdownRequested,
          vaultProjectNames,
        );

        try { federationDb.close(); } catch { /* ignore */ }

        if (vaultEmbedCount > 0) {
          process.stderr.write(
            `[pai-daemon] Vault embed pass complete: ${vaultEmbedCount} vault chunks embedded\n`
          );
        }
      } catch (ve) {
        const vmsg = ve instanceof Error ? ve.message : String(ve);
        process.stderr.write(`[pai-daemon] Vault embed error: ${vmsg}\n`);
      }
    }

    const elapsed = Date.now() - t0;
    lastEmbedTime = Date.now();
    process.stderr.write(
      `[pai-daemon] Embed pass complete: ${count} postgres chunks + ${vaultEmbedCount} vault chunks embedded (${elapsed}ms)\n`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Embed error: ${msg}\n`);
  } finally {
    embedInProgress = false;
  }
}

/**
 * Start the periodic embed scheduler.
 * Initial run is 30 seconds after startup (after the 2-second index startup run).
 */
function startEmbedScheduler(): void {
  const intervalMs = daemonConfig.embedIntervalSecs * 1_000;

  process.stderr.write(
    `[pai-daemon] Embed scheduler: every ${daemonConfig.embedIntervalSecs}s\n`
  );

  // Initial embed run 60 seconds after startup (lets index + vault index finish)
  setTimeout(() => {
    runEmbed().catch((e) => {
      process.stderr.write(`[pai-daemon] Startup embed error: ${e}\n`);
    });
  }, 60_000);

  embedSchedulerTimer = setInterval(() => {
    runEmbed().catch((e) => {
      process.stderr.write(`[pai-daemon] Scheduled embed error: ${e}\n`);
    });
  }, intervalMs);

  // Don't let the interval keep the process alive if all else exits
  if (embedSchedulerTimer.unref) {
    embedSchedulerTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch an IPC tool call to the appropriate tool function.
 * Returns the tool result or throws.
 */
async function dispatchTool(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  // Cast through unknown to satisfy TypeScript's strict overlap check on
  // Record<string, unknown> → specific param types. Runtime validation is
  // the responsibility of each tool function (they surface errors gracefully).
  const p = params as unknown;

  switch (method) {
    case "memory_search":
      return toolMemorySearch(registryDb, storageBackend, p as Parameters<typeof toolMemorySearch>[2]);

    case "memory_get":
      return toolMemoryGet(registryDb, p as Parameters<typeof toolMemoryGet>[1]);

    case "project_info":
      return toolProjectInfo(registryDb, p as Parameters<typeof toolProjectInfo>[1]);

    case "project_list":
      return toolProjectList(registryDb, p as Parameters<typeof toolProjectList>[1]);

    case "session_list":
      return toolSessionList(registryDb, p as Parameters<typeof toolSessionList>[1]);

    case "registry_search":
      return toolRegistrySearch(registryDb, p as Parameters<typeof toolRegistrySearch>[1]);

    case "project_detect":
      return toolProjectDetect(registryDb, p as Parameters<typeof toolProjectDetect>[1]);

    case "project_health":
      return toolProjectHealth(registryDb, p as Parameters<typeof toolProjectHealth>[1]);

    case "project_todo":
      return toolProjectTodo(registryDb, p as Parameters<typeof toolProjectTodo>[1]);

    case "topic_check":
      return detectTopicShift(
        registryDb,
        storageBackend,
        p as Parameters<typeof detectTopicShift>[2]
      );

    case "session_auto_route":
      return toolSessionRoute(
        registryDb,
        storageBackend,
        p as Parameters<typeof toolSessionRoute>[2]
      );

    case "zettel_explore":
    case "zettel_health":
    case "zettel_surprise":
    case "zettel_suggest":
    case "zettel_converse":
    case "zettel_themes": {
      // Zettel tools need the raw federation DB (vaultDb is always available regardless of primary backend)
      const { toolZettelExplore, toolZettelHealth, toolZettelSurprise, toolZettelSuggest, toolZettelConverse, toolZettelThemes } = await import("../mcp/tools.js");

      if (!vaultDb) {
        throw new Error("Zettel tools require vault database (federation.db) — could not be opened at startup");
      }

      switch (method) {
        case "zettel_explore": return toolZettelExplore(vaultDb, p as Parameters<typeof toolZettelExplore>[1]);
        case "zettel_health": return toolZettelHealth(vaultDb, p as Parameters<typeof toolZettelHealth>[1]);
        case "zettel_surprise": return toolZettelSurprise(vaultDb, p as Parameters<typeof toolZettelSurprise>[1]);
        case "zettel_suggest": return toolZettelSuggest(vaultDb, p as Parameters<typeof toolZettelSuggest>[1]);
        case "zettel_converse": return toolZettelConverse(vaultDb, p as Parameters<typeof toolZettelConverse>[1]);
        case "zettel_themes": return toolZettelThemes(vaultDb, p as Parameters<typeof toolZettelThemes>[1]);
      }
      break;
    }

    case "graph_clusters": {
      // graph_clusters uses the SQLite federation DB for clustering and,
      // optionally, the Postgres pool for observation-type enrichment.
      // vaultDb is always the SQLite handle regardless of primary backend.
      const { handleGraphClusters } = await import("../graph/clusters.js");

      if (!vaultDb) {
        throw new Error("graph_clusters requires vault database (federation.db) — could not be opened at startup");
      }
      // When primary backend is Postgres, also pass the pool for observation enrichment.
      const pgPool = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;

      return handleGraphClusters(
        pgPool,
        vaultDb,
        p as Parameters<typeof handleGraphClusters>[2]
      );
    }

    case "graph_neighborhood": {
      // graph_neighborhood returns per-note nodes and wikilink edges for a
      // given set of vault paths (typically the notes inside a cluster).
      // vaultDb is always the SQLite handle regardless of primary backend.
      const { handleGraphNeighborhood } = await import("../graph/neighborhood.js");

      if (!vaultDb) {
        throw new Error("graph_neighborhood requires vault database (federation.db) — could not be opened at startup");
      }
      // When primary backend is Postgres, also pass the pool for observation enrichment.
      const pgPool2 = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;

      return handleGraphNeighborhood(
        pgPool2,
        vaultDb,
        p as Parameters<typeof handleGraphNeighborhood>[2]
      );
    }

    case "graph_note_context": {
      // graph_note_context returns the full 1-hop vault neighbourhood for a
      // single focal note (Level 3 drill-down). Crosses cluster boundaries so
      // users can discover connections to notes in other topic areas.
      // vaultDb is always the SQLite handle regardless of primary backend.
      const { handleGraphNoteContext } = await import("../graph/note-context.js");

      if (!vaultDb) {
        throw new Error("graph_note_context requires vault database (federation.db) — could not be opened at startup");
      }
      // When primary backend is Postgres, also pass the pool for observation enrichment.
      const pgPool3 = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;

      return handleGraphNoteContext(
        pgPool3,
        vaultDb,
        p as Parameters<typeof handleGraphNoteContext>[2]
      );
    }

    case "graph_trace": {
      // graph_trace returns a chronological timeline of notes matching a topic/keyword.
      // Uses vault_files + memory_chunks + vault_links — all in vaultDb (SQLite).
      const { handleGraphTrace } = await import("../graph/trace.js");

      if (!vaultDb) {
        throw new Error("graph_trace requires vault database (federation.db) — could not be opened at startup");
      }

      return handleGraphTrace(
        vaultDb,
        p as Parameters<typeof handleGraphTrace>[1]
      );
    }

    case "graph_latent_ideas": {
      // graph_latent_ideas surfaces recurring themes that have no dedicated note yet.
      // Reuses zettelThemes clustering then filters out clusters with matching titles.
      const { handleGraphLatentIdeas } = await import("../graph/latent-ideas.js");

      if (!vaultDb) {
        throw new Error("graph_latent_ideas requires vault database (federation.db) — could not be opened at startup");
      }

      return handleGraphLatentIdeas(
        vaultDb,
        p as Parameters<typeof handleGraphLatentIdeas>[1]
      );
    }

    case "idea_materialize": {
      // idea_materialize writes a new Markdown note to the vault filesystem.
      // Requires daemonConfig.vaultPath to locate the vault root.
      const { handleIdeaMaterialize } = await import("../graph/latent-ideas.js");

      if (!daemonConfig.vaultPath) {
        throw new Error("idea_materialize requires vaultPath to be configured in the daemon config");
      }

      return handleIdeaMaterialize(
        p as Parameters<typeof handleIdeaMaterialize>[0],
        daemonConfig.vaultPath
      );
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// IPC server
// ---------------------------------------------------------------------------

function sendResponse(socket: Socket, response: IpcResponse): void {
  try {
    socket.write(JSON.stringify(response) + "\n");
  } catch {
    // Socket may already be closed
  }
}

/**
 * Handle a single IPC request.
 */
async function handleRequest(
  request: IpcRequest,
  socket: Socket
): Promise<void> {
  const { id, method, params } = request;

  // Special: status
  if (method === "status") {
    const dbStats = await (async () => {
      try {
        const fedStats = await storageBackend.getStats();
        const projects = (
          registryDb
            .prepare("SELECT COUNT(*) AS n FROM projects")
            .get() as { n: number }
        ).n;
        return { files: fedStats.files, chunks: fedStats.chunks, projects };
      } catch {
        return null;
      }
    })();

    sendResponse(socket, {
      id,
      ok: true,
      result: {
        uptime: Math.floor((Date.now() - startTime) / 1000),
        indexInProgress,
        lastIndexTime: lastIndexTime ? new Date(lastIndexTime).toISOString() : null,
        indexIntervalSecs: daemonConfig.indexIntervalSecs,
        embedInProgress,
        lastEmbedTime: lastEmbedTime ? new Date(lastEmbedTime).toISOString() : null,
        embedIntervalSecs: daemonConfig.embedIntervalSecs,
        socketPath: daemonConfig.socketPath,
        storageBackend: storageBackend.backendType,
        db: dbStats,
        vaultIndexInProgress,
        lastVaultIndexTime: lastVaultIndexTime ? new Date(lastVaultIndexTime).toISOString() : null,
        vaultPath: daemonConfig.vaultPath ?? null,
      },
    });
    socket.end();
    return;
  }

  // Special: index_now — trigger immediate index (non-blocking response)
  if (method === "index_now") {
    // Fire and forget — don't await
    runIndex().catch((e) => {
      process.stderr.write(`[pai-daemon] index_now error: ${e}\n`);
    });
    sendResponse(socket, { id, ok: true, result: { triggered: true } });
    socket.end();
    return;
  }

  // Special: vault_index_now — trigger immediate vault index (non-blocking response)
  if (method === "vault_index_now") {
    runVaultIndex().catch((e) => {
      process.stderr.write(`[pai-daemon] vault_index_now error: ${e}\n`);
    });
    sendResponse(socket, { id, ok: true, result: { triggered: true } });
    socket.end();
    return;
  }

  // Special: notification_get_config — return current notification config
  if (method === "notification_get_config") {
    sendResponse(socket, {
      id,
      ok: true,
      result: {
        config: notificationConfig,
        activeChannels: Object.entries(notificationConfig.channels)
          .filter(([ch, cfg]) => ch !== "voice" && (cfg as { enabled: boolean }).enabled)
          .map(([ch]) => ch),
      },
    });
    socket.end();
    return;
  }

  // Special: notification_set_config — patch the notification config
  if (method === "notification_set_config") {
    try {
      const p = params as {
        mode?: NotificationMode;
        channels?: Record<string, unknown>;
        routing?: Record<string, unknown>;
      };
      notificationConfig = patchNotificationConfig({
        mode: p.mode,
        channels: p.channels as Parameters<typeof patchNotificationConfig>[0]["channels"],
        routing: p.routing as Parameters<typeof patchNotificationConfig>[0]["routing"],
      });
      sendResponse(socket, {
        id,
        ok: true,
        result: { config: notificationConfig },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  // Special: notification_send — route a notification to configured channels
  if (method === "notification_send") {
    const p = params as {
      event?: string;
      message?: string;
      title?: string;
    };

    if (!p.message) {
      sendResponse(socket, { id, ok: false, error: "notification_send: message is required" });
      socket.end();
      return;
    }

    const event = (p.event as NotificationConfig["routing"] extends Record<infer K, unknown> ? K : string) ?? "info";

    routeNotification(
      {
        event: event as Parameters<typeof routeNotification>[0]["event"],
        message: p.message,
        title: p.title,
      },
      notificationConfig
    ).then((result) => {
      sendResponse(socket, { id, ok: true, result });
      socket.end();
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
      socket.end();
    });
    return;
  }

  // ---- Observation methods (Postgres only) --------------------------------

  if (method === "observation_store") {
    const pool = (storageBackend as PostgresBackendWithPool).getPool?.();
    if (!pool) {
      sendResponse(socket, { id, ok: false, error: "Observations require Postgres backend" });
      socket.end();
      return;
    }
    try {
      const p = params as {
        session_id: string;
        type: string;
        title: string;
        narrative?: string;
        tool_name: string;
        tool_input_summary?: string;
        files_read?: string[];
        files_modified?: string[];
        concepts?: string[];
        content_hash?: string;
        cwd?: string;
      };

      // Resolve project_id and project_slug from cwd via registry
      let project_id: number | null = null;
      let project_slug: string | null = null;
      if (p.cwd) {
        const row = registryDb.prepare(
          "SELECT id, slug FROM projects WHERE status = 'active' AND ? LIKE root_path || '%' ORDER BY length(root_path) DESC LIMIT 1"
        ).get(p.cwd) as { id: number; slug: string } | undefined;
        if (row) {
          project_id = row.id;
          project_slug = row.slug;
        }
      }

      const insertedId = await storeObservation(pool, {
        session_id: p.session_id,
        project_id,
        project_slug,
        type: p.type as "decision" | "bugfix" | "feature" | "refactor" | "discovery" | "change",
        title: p.title,
        narrative: p.narrative ?? null,
        tool_name: p.tool_name,
        tool_input_summary: p.tool_input_summary ?? null,
        files_read: p.files_read ?? [],
        files_modified: p.files_modified ?? [],
        concepts: p.concepts ?? [],
      });

      sendResponse(socket, { id, ok: true, result: { ok: true, id: insertedId } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  if (method === "observation_query") {
    const pool = (storageBackend as PostgresBackendWithPool).getPool?.();
    if (!pool) {
      sendResponse(socket, { id, ok: false, error: "Observations require Postgres backend" });
      socket.end();
      return;
    }
    try {
      const p = params as {
        project_id?: number;
        session_id?: string;
        type?: string;
        limit?: number;
        offset?: number;
      };

      const rows = await queryObservations(pool, {
        projectId: p.project_id,
        sessionId: p.session_id,
        type: p.type,
        limit: p.limit,
        offset: p.offset,
      });
      sendResponse(socket, { id, ok: true, result: rows });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  if (method === "observation_recent") {
    const pool = (storageBackend as PostgresBackendWithPool).getPool?.();
    if (!pool) {
      sendResponse(socket, { id, ok: false, error: "Observations require Postgres backend" });
      socket.end();
      return;
    }
    try {
      const p = params as { project_id?: number; cwd?: string; limit?: number };
      const limit = p.limit ?? 20;

      // Resolve project_id from cwd if not provided directly (same pattern as observation_store)
      let resolvedProjectId = p.project_id;
      let resolvedProjectSlug: string | undefined;
      if (resolvedProjectId === undefined && p.cwd) {
        const row = registryDb.prepare(
          "SELECT id, slug FROM projects WHERE status = 'active' AND ? LIKE root_path || '%' ORDER BY length(root_path) DESC LIMIT 1"
        ).get(p.cwd) as { id: number; slug: string } | undefined;
        if (row) {
          resolvedProjectId = row.id;
          resolvedProjectSlug = row.slug;
        }
      }

      let rows;
      if (resolvedProjectId !== undefined) {
        rows = await queryRecentObservations(pool, resolvedProjectId, limit);
      } else {
        rows = await queryObservations(pool, { limit });
      }
      sendResponse(socket, { id, ok: true, result: { rows, project_slug: resolvedProjectSlug } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  // observation_list — alias for observation_query with project slug resolution
  if (method === "observation_list") {
    const pool = (storageBackend as PostgresBackendWithPool).getPool?.();
    if (!pool) {
      sendResponse(socket, { id, ok: false, error: "Observations require Postgres backend" });
      socket.end();
      return;
    }
    try {
      const p = params as {
        project_slug?: string;
        session_id?: string;
        type?: string;
        limit?: number;
        offset?: number;
      };

      let projectId: number | undefined;
      if (p.project_slug) {
        const row = registryDb.prepare(
          "SELECT id FROM projects WHERE slug = ?"
        ).get(p.project_slug) as { id: number } | undefined;
        projectId = row?.id;
      }

      const rows = await queryObservations(pool, {
        projectId,
        sessionId: p.session_id,
        type: p.type,
        limit: p.limit ?? 20,
        offset: p.offset ?? 0,
      });
      sendResponse(socket, { id, ok: true, result: rows });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  // observation_stats — aggregate statistics
  if (method === "observation_stats") {
    const pool = (storageBackend as PostgresBackendWithPool).getPool?.();
    if (!pool) {
      sendResponse(socket, { id, ok: false, error: "Observations require Postgres backend" });
      socket.end();
      return;
    }
    try {
      await ensureObservationTables(pool);
      const [totalRes, byTypeRes, byProjectRes, recentRes] = await Promise.all([
        pool.query<{ count: string }>("SELECT COUNT(*) as count FROM pai_observations"),
        pool.query<{ type: string; count: string }>(
          "SELECT type, COUNT(*) as count FROM pai_observations GROUP BY type ORDER BY count DESC"
        ),
        pool.query<{ project_slug: string | null; count: string }>(
          "SELECT project_slug, COUNT(*) as count FROM pai_observations GROUP BY project_slug ORDER BY count DESC LIMIT 15"
        ),
        pool.query<{ created_at: string }>(
          "SELECT created_at FROM pai_observations ORDER BY created_at DESC LIMIT 1"
        ),
      ]);

      sendResponse(socket, {
        id,
        ok: true,
        result: {
          total: parseInt(totalRes.rows[0]?.count ?? "0", 10),
          by_type: byTypeRes.rows.map(r => ({ type: r.type, count: parseInt(r.count, 10) })),
          by_project: byProjectRes.rows.map(r => ({ project_slug: r.project_slug, count: parseInt(r.count, 10) })),
          most_recent: recentRes.rows[0]?.created_at ?? null,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  if (method === "session_summary_store") {
    const pool = (storageBackend as PostgresBackendWithPool).getPool?.();
    if (!pool) {
      sendResponse(socket, { id, ok: false, error: "Session summaries require Postgres backend" });
      socket.end();
      return;
    }
    try {
      const p = params as {
        session_id: string;
        project_id?: number;
        project_slug?: string;
        cwd?: string;
        request?: string;
        investigated?: string;
        learned?: string;
        completed?: string;
        next_steps?: string;
        observation_count?: number;
      };

      // Resolve project_id and project_slug from cwd if not provided directly
      let resolvedProjectId = p.project_id ?? null;
      let resolvedProjectSlug = p.project_slug ?? null;
      if (resolvedProjectId === null && p.cwd) {
        const row = registryDb.prepare(
          "SELECT id, slug FROM projects WHERE status = 'active' AND ? LIKE root_path || '%' ORDER BY length(root_path) DESC LIMIT 1"
        ).get(p.cwd) as { id: number; slug: string } | undefined;
        if (row) {
          resolvedProjectId = row.id;
          resolvedProjectSlug = row.slug;
        }
      }

      await storeSessionSummary(pool, {
        session_id: p.session_id,
        project_id: resolvedProjectId,
        project_slug: resolvedProjectSlug,
        request: p.request ?? null,
        investigated: p.investigated ?? null,
        learned: p.learned ?? null,
        completed: p.completed ?? null,
        next_steps: p.next_steps ?? null,
        observation_count: p.observation_count ?? 0,
      });

      sendResponse(socket, { id, ok: true, result: { ok: true } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  // All other methods: PAI tool dispatch
  try {
    const result = await dispatchTool(method, params);
    sendResponse(socket, { id, ok: true, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendResponse(socket, { id, ok: false, error: msg });
  }
  socket.end();
}

/**
 * Check whether an existing socket file is actually being served by a live process.
 * Returns true if a daemon is already accepting connections, false otherwise.
 */
function isSocketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect(path);
    const timer = setTimeout(() => { client.destroy(); resolve(false); }, 500);
    client.on("connect", () => { clearTimeout(timer); client.end(); resolve(true); });
    client.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * Start the Unix Domain Socket IPC server.
 */
async function startIpcServer(socketPath: string): Promise<Server> {
  // Before removing the socket file, check whether another daemon is already live
  if (existsSync(socketPath)) {
    const live = await isSocketLive(socketPath);
    if (live) {
      throw new Error("Another daemon is already running — socket is live. Aborting startup.");
    }
    try {
      unlinkSync(socketPath);
      process.stderr.write("[pai-daemon] Removed stale socket file.\n");
    } catch {
      // If we can't remove it, bind will fail with a clear error
    }
  }

  const server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      // Process every complete newline-delimited frame in this chunk
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        if (line.trim() === "") continue; // skip blank lines between frames

        let request: IpcRequest;
        try {
          request = JSON.parse(line) as IpcRequest;
        } catch {
          sendResponse(socket, { id: "?", ok: false, error: "Invalid JSON" });
          socket.destroy();
          return;
        }

        handleRequest(request, socket).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          sendResponse(socket, { id: request.id, ok: false, error: msg });
          socket.destroy();
        });
      }
    });

    socket.on("error", () => {
      // Client disconnected — nothing to do
    });
  });

  server.on("error", (e) => {
    process.stderr.write(`[pai-daemon] IPC server error: ${e}\n`);
  });

  server.listen(socketPath, () => {
    process.stderr.write(
      `[pai-daemon] IPC server listening on ${socketPath}\n`
    );
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main daemon entry point
// ---------------------------------------------------------------------------

export async function serve(config: PaiDaemonConfig): Promise<void> {
  daemonConfig = config;
  startTime = Date.now();

  // Load notification config from disk (merged with defaults)
  notificationConfig = loadNotificationConfig();

  process.stderr.write("[pai-daemon] Starting daemon...\n");
  process.stderr.write(`[pai-daemon] Socket: ${config.socketPath}\n`);
  process.stderr.write(`[pai-daemon] Storage backend: ${config.storageBackend}\n`);
  process.stderr.write(
    `[pai-daemon] Notification mode: ${notificationConfig.mode}\n`
  );

  // Lower the daemon's scheduling priority so it yields CPU to interactive
  // Claude Code sessions and editor processes during indexing and embedding.
  // niceness 10 = noticeably lower priority without making it unresponsive.
  // Non-fatal: some environments (containers, restricted sandboxes) may deny it.
  try { setPriority(process.pid, 10); } catch { /* non-fatal */ }

  // Configure embedding model from config (before any embed work starts)
  configureEmbeddingModel(config.embeddingModel);

  // Open registry (always SQLite)
  try {
    registryDb = openRegistry();
    process.stderr.write("[pai-daemon] Registry database opened.\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Fatal: Could not open registry: ${msg}\n`);
    process.exit(1);
  }

  // Open federation storage (SQLite or Postgres with auto-fallback)
  try {
    storageBackend = await createStorageBackend(config);
    process.stderr.write(
      `[pai-daemon] Federation backend: ${storageBackend.backendType}\n`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Fatal: Could not open federation storage: ${msg}\n`);
    process.exit(1);
  }

  // Always open a SQLite handle to federation.db for vault and graph tools.
  // When the primary backend is SQLite, reuse its existing DB handle.
  // When the primary backend is Postgres, open a separate read-only SQLite connection
  // so vault tools work even when observations live in Postgres.
  if (storageBackend.backendType === "sqlite") {
    const { SQLiteBackend } = await import("../storage/sqlite.js");
    if (storageBackend instanceof SQLiteBackend) {
      vaultDb = (storageBackend as SQLiteBackendWithDb).getRawDb();
      vaultDbOwnedSeparately = false;
      process.stderr.write("[pai-daemon] Vault DB: using primary SQLite handle.\n");
    }
  } else {
    // Postgres primary — open federation.db read-only for vault tools
    const federationDbPath = join(homedir(), ".pai", "federation.db");
    try {
      const BetterSqlite3 = (await import("better-sqlite3")).default;
      vaultDb = new BetterSqlite3(federationDbPath, { readonly: true });
      vaultDbOwnedSeparately = true;
      process.stderr.write(`[pai-daemon] Vault DB: opened ${federationDbPath} read-only for vault tools.\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[pai-daemon] Warning: Could not open federation.db for vault tools (${msg}). Vault/graph tools will be unavailable.\n`);
    }
  }

  // Start index scheduler
  startIndexScheduler();

  // Start embed scheduler (Postgres backend only)
  if (storageBackend.backendType === "postgres") {
    startEmbedScheduler();
  } else {
    process.stderr.write(
      "[pai-daemon] Embed scheduler: disabled (SQLite backend)\n"
    );
  }

  // Start IPC server (async: checks for a live daemon before unlinking socket)
  const server = await startIpcServer(config.socketPath);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[pai-daemon] ${signal} received. Stopping.\n`);

    // Signal all long-running loops to stop between batches
    shutdownRequested = true;

    // Stop schedulers so no new runs are launched
    if (indexSchedulerTimer) {
      clearInterval(indexSchedulerTimer);
    }

    if (embedSchedulerTimer) {
      clearInterval(embedSchedulerTimer);
    }

    // Stop accepting new IPC connections
    server.close();

    // Wait for any in-progress index or embed pass to finish, up to 10 s.
    // Without this wait, closing the pool while an async query is running
    // causes "Cannot use a pool after calling end on the pool" and a dirty crash.
    const SHUTDOWN_TIMEOUT_MS = 10_000;
    const POLL_INTERVAL_MS = 100;
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;

    if (indexInProgress || embedInProgress) {
      process.stderr.write(
        `[pai-daemon] Waiting for in-progress operations to finish ` +
          `(index=${indexInProgress}, embed=${embedInProgress})...\n`
      );

      while ((indexInProgress || embedInProgress) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      if (indexInProgress || embedInProgress) {
        process.stderr.write(
          "[pai-daemon] Shutdown timeout reached — forcing exit.\n"
        );
      } else {
        process.stderr.write("[pai-daemon] In-progress operations finished.\n");
      }
    }

    try {
      await storageBackend.close();
    } catch {
      // ignore
    }

    // Close vault DB if it was separately opened (Postgres primary path)
    if (vaultDbOwnedSeparately && vaultDb) {
      try {
        vaultDb.close();
      } catch {
        // ignore
      }
    }

    try {
      unlinkSync(config.socketPath);
    } catch {
      // ignore
    }

    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(0)); });

  // Keep process alive
  await new Promise(() => {});
}
