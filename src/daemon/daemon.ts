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
import { setPriority } from "node:os";
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

// Index scheduler state
let indexInProgress = false;
let lastIndexTime = 0;
let indexSchedulerTimer: ReturnType<typeof setInterval> | null = null;

// Embed scheduler state
let embedInProgress = false;
let lastEmbedTime = 0;
let embedSchedulerTimer: ReturnType<typeof setInterval> | null = null;

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
 * Start the periodic index scheduler.
 */
function startIndexScheduler(): void {
  const intervalMs = daemonConfig.indexIntervalSecs * 1_000;

  process.stderr.write(
    `[pai-daemon] Index scheduler: every ${daemonConfig.indexIntervalSecs}s\n`
  );

  // Run an initial index at startup (non-blocking — let the socket come up first)
  setTimeout(() => {
    runIndex().catch((e) => {
      process.stderr.write(`[pai-daemon] Startup index error: ${e}\n`);
    });
  }, 2_000);

  indexSchedulerTimer = setInterval(() => {
    runIndex().catch((e) => {
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

    const { embedChunksWithBackend } = await import("../memory/indexer-backend.js");
    const count = await embedChunksWithBackend(storageBackend, () => shutdownRequested);

    const elapsed = Date.now() - t0;
    lastEmbedTime = Date.now();
    process.stderr.write(
      `[pai-daemon] Embed pass complete: ${count} chunks embedded (${elapsed}ms)\n`
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

  // Initial embed run 30 seconds after startup (lets the first index run finish)
  setTimeout(() => {
    runEmbed().catch((e) => {
      process.stderr.write(`[pai-daemon] Startup embed error: ${e}\n`);
    });
  }, 30_000);

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
