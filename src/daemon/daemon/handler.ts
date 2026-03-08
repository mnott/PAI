/**
 * IPC request handler — processes all inbound IPC methods and sends responses.
 */

import type { Socket } from "node:net";
import type { IpcRequest, IpcResponse, PostgresBackendWithPool } from "./types.js";
import type { NotificationMode } from "../../notifications/types.js";
import {
  patchNotificationConfig,
} from "../../notifications/config.js";
import { routeNotification } from "../../notifications/router.js";
import {
  ensureObservationTables,
  storeObservation,
  queryObservations,
  queryRecentObservations,
  storeSessionSummary,
} from "../../observations/store.js";
import {
  registryDb,
  storageBackend,
  daemonConfig,
  startTime,
  indexInProgress,
  lastIndexTime,
  embedInProgress,
  lastEmbedTime,
  vaultIndexInProgress,
  lastVaultIndexTime,
  notificationConfig,
  setNotificationConfig,
} from "./state.js";
import { runIndex, runVaultIndex } from "./scheduler.js";
import { dispatchTool } from "./dispatcher.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

export function sendResponse(socket: Socket, response: IpcResponse): void {
  try {
    socket.write(JSON.stringify(response) + "\n");
  } catch {
    // Socket may already be closed
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle a single IPC request.
 */
export async function handleRequest(
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

  // Special: notification_get_config
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

  // Special: notification_set_config
  if (method === "notification_set_config") {
    try {
      const p = params as {
        mode?: NotificationMode;
        channels?: Record<string, unknown>;
        routing?: Record<string, unknown>;
      };
      const updated = patchNotificationConfig({
        mode: p.mode,
        channels: p.channels as Parameters<typeof patchNotificationConfig>[0]["channels"],
        routing: p.routing as Parameters<typeof patchNotificationConfig>[0]["routing"],
      });
      setNotificationConfig(updated);
      sendResponse(socket, { id, ok: true, result: { config: updated } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  // Special: notification_send
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

    const event = (p.event as Parameters<typeof routeNotification>[0]["event"]) ?? "info";

    routeNotification(
      { event, message: p.message, title: p.title },
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

      await ensureObservationTables(pool);
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
