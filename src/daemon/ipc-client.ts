/**
 * ipc-client.ts — IPC client for the PAI Daemon MCP shim
 *
 * PaiClient connects to the Unix Domain Socket served by daemon.ts
 * and forwards tool calls to the daemon. Uses a fresh socket connection per
 * call (connect → write JSON + newline → read response line → parse → destroy).
 * This keeps the client stateless and avoids connection management complexity.
 *
 * Adapted from the Coogle ipc-client pattern (which was adapted from Whazaa).
 */

import { connect, Socket } from "node:net";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  NotificationConfig,
  NotificationMode,
  NotificationEvent,
  SendResult,
} from "../notifications/types.js";
import type { TopicCheckParams, TopicCheckResult } from "../topics/detector.js";
import type { AutoRouteResult } from "../session/auto-route.js";
import { paiSocketPath } from "../runtime-paths.js";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/** Default socket path */
export const IPC_SOCKET_PATH = paiSocketPath();

/** Timeout for IPC calls (60 seconds) */
const IPC_TIMEOUT_MS = 60_000;

/** Timeout for code-graph calls (they can walk a repo, but never need a minute) */
const IPC_CODE_TIMEOUT_MS = 30_000;

/** How long a connect/restart failure is retried before giving up */
const IPC_RESTART_WINDOW_MS = 20_000;

function defaultTimeoutFor(method: string): number {
  return method.startsWith("code_") ? IPC_CODE_TIMEOUT_MS : IPC_TIMEOUT_MS;
}

type IpcAttemptError = Error & { retryable?: boolean };

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
// Client
// ---------------------------------------------------------------------------

/**
 * Methods safe to re-send after an accepted request was dropped (pure reads).
 * Derived from the daemon registry (handler.ts + dispatcher.ts); default = not retried.
 */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "status", "memory_dashboard", "notification_get_config", "work_queue_stats",
  "observation_query", "observation_recent", "observation_list", "observation_stats",
  "skill_telemetry_query",
  "code_callers", "code_explore", "code_search", "code_summary",
  "graph_clusters", "graph_latent_ideas", "graph_neighborhood", "graph_note_context", "graph_related", "graph_trace",
  "kg_contradictions", "kg_query",
  "memory_get", "memory_kg_search", "memory_lessons", "memory_outline", "memory_search",
  "memory_taxonomy", "memory_tunnels", "memory_wakeup",
  "project_detect", "project_health", "project_info", "project_list", "project_todo",
  "registry_search", "session_auto_route", "session_list", "topic_check",
  "zettel_communities", "zettel_converse", "zettel_explore", "zettel_god_notes", "zettel_health",
  "zettel_suggest", "zettel_surprise", "zettel_themes",
]);

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}

/**
 * Thin IPC proxy that forwards tool calls to pai-daemon over a Unix
 * Domain Socket. Each call opens a fresh connection, sends one NDJSON request,
 * reads the response, and closes. Stateless and simple.
 */
export class PaiClient {
  private readonly socketPath: string;
  private readonly restartWindowMs: number;

  constructor(socketPath?: string, opts?: { restartWindowMs?: number }) {
    this.socketPath = socketPath ?? IPC_SOCKET_PATH;
    this.restartWindowMs = opts?.restartWindowMs ?? IPC_RESTART_WINDOW_MS;
  }

  /**
   * Call a PAI tool by name with the given params.
   * Returns the tool result or throws on error.
   *
   * `timeoutMs` overrides the default 60s wait — for a caller on a hook's
   * critical path (e.g. the threshold-triggered handover enqueue in
   * `cli/commands/session/autosave.ts`) where the actual work happens later,
   * asynchronously, in the daemon's worker loop, and only the cheap
   * enqueue handshake itself should ever be waited on.
   */
  async call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.send(method, params, timeoutMs);
  }

  /**
   * Check daemon status.
   */
  async status(): Promise<Record<string, unknown>> {
    const result = await this.send("status", {});
    return result as Record<string, unknown>;
  }

  /**
   * Trigger an immediate index run.
   */
  async triggerIndex(): Promise<void> {
    await this.send("index_now", {});
  }

  /** Trigger an immediate embed pass. */
  async triggerEmbed(): Promise<void> {
    await this.send("embed_now", {});
  }

  // -------------------------------------------------------------------------
  // Notification methods
  // -------------------------------------------------------------------------

  /**
   * Get the current notification config from the daemon.
   */
  async getNotificationConfig(): Promise<{
    config: NotificationConfig;
    activeChannels: string[];
  }> {
    const result = await this.send("notification_get_config", {});
    return result as { config: NotificationConfig; activeChannels: string[] };
  }

  /**
   * Patch the notification config on the daemon (and persist to disk).
   */
  async setNotificationConfig(patch: {
    mode?: NotificationMode;
    channels?: Partial<NotificationConfig["channels"]>;
    routing?: Partial<NotificationConfig["routing"]>;
  }): Promise<{ config: NotificationConfig }> {
    const result = await this.send("notification_set_config", patch as Record<string, unknown>);
    return result as { config: NotificationConfig };
  }

  /**
   * Send a notification via the daemon (routes to configured channels).
   */
  async sendNotification(payload: {
    event: NotificationEvent;
    message: string;
    title?: string;
  }): Promise<SendResult> {
    const result = await this.send("notification_send", payload as Record<string, unknown>);
    return result as SendResult;
  }

  // -------------------------------------------------------------------------
  // Topic detection methods
  // -------------------------------------------------------------------------

  /**
   * Check whether the provided context text has drifted to a different project
   * than the session's current routing.
   */
  async topicCheck(params: TopicCheckParams): Promise<TopicCheckResult> {
    const result = await this.send("topic_check", params as unknown as Record<string, unknown>);
    return result as TopicCheckResult;
  }

  // -------------------------------------------------------------------------
  // Session routing methods
  // -------------------------------------------------------------------------

  /**
   * Automatically detect which project a session belongs to.
   * Tries path match, PAI.md marker walk, then topic detection (if context given).
   */
  async sessionAutoRoute(params: {
    cwd?: string;
    context?: string;
  }): Promise<AutoRouteResult | null> {
    // session_auto_route returns a ToolResult (content array). Extract the text
    // and parse JSON from it.
    const result = await this.send("session_auto_route", params as Record<string, unknown>);
    const toolResult = result as { content?: Array<{ text: string }>; isError?: boolean };
    if (toolResult.isError) return null;
    const text = toolResult.content?.[0]?.text ?? "";
    // Text is either JSON (on match) or a human-readable "no match" message
    try {
      return JSON.parse(text) as AutoRouteResult;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal transport
  // -------------------------------------------------------------------------

  /**
   * Send an IPC request, retrying with short backoff while the daemon is
   * restarting (socket missing/refused, connection dropped, or the old daemon's
   * "restarting" error), for up to `restartWindowMs`. A genuinely slow call is
   * bounded by `timeoutMs` overall; on any restart/timeout failure the error
   * says so and carries a health summary instead of a bare timeout.
   */
  private async send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = defaultTimeoutFor(method)
  ): Promise<unknown> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const restartDeadline = started + this.restartWindowMs;
    let delay = 100;
    let lastReason = "";
    for (;;) {
      const remaining = deadline - Date.now();
      try {
        return await this.attempt(method, params, Math.max(remaining, 1));
      } catch (e) {
        const err = e as IpcAttemptError;
        if (!err.retryable) throw err;
        lastReason = err.message;
        if (Date.now() + delay >= Math.min(restartDeadline, deadline)) {
          throw new Error(`PAI daemon is restarting (or down): ${await this.healthSummary(lastReason)}`);
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 1000);
      }
    }
  }

  /** One-line health summary for error messages (never throws, ~1 s bound). */
  private async healthSummary(reason: string): Promise<string> {
    const sock = existsSync(this.socketPath) ? "socket present" : "socket missing";
    let status = "no status answer";
    try {
      const r = (await this.attempt("status", {}, 1000)) as { uptime?: number };
      status = `status ok, uptime ${r.uptime ?? "?"}s`;
    } catch {
      // keep default
    }
    return `${sock}, ${status}; last error: ${reason}`;
  }

  /** One connection attempt. Rejects with `retryable` set for restart-class failures. */
  private attempt(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const socketPath = this.socketPath;

    return new Promise((resolve, reject) => {
      let socket: Socket | null = null;
      let done = false;
      let connected = false;
      let buffer = "";
      let timer: ReturnType<typeof setTimeout> | null = null;
      let watch: ReturnType<typeof setInterval> | null = null;

      function finish(error: IpcAttemptError | null, value?: unknown): void {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        if (watch !== null) clearInterval(watch);
        try {
          socket?.destroy();
        } catch {
          // ignore
        }
        if (error) reject(error);
        else resolve(value);
      }

      // `neverRan`: the request provably never reached a handler (connect failed,
      // or the daemon's explicit pre-execution restart rejection). Otherwise the
      // old daemon may already have executed it, so only read-only methods retry.
      const retry = (msg: string, neverRan = false): void => {
        if (!neverRan && !isReadOnlyMethod(method)) {
          finish(new Error(
            `PAI daemon restarted while handling ${method}; it may or may not have run, check state before retrying`
          ));
          return;
        }
        const e: IpcAttemptError = new Error(msg);
        e.retryable = true;
        finish(e);
      };

      socket = connect(socketPath, () => {
        connected = true;
        const request: IpcRequest = { id: randomUUID(), method, params };
        socket!.write(JSON.stringify(request) + "\n");
      });

      // A daemon that is shutting down unlinks its socket first. If the file is
      // gone while we wait, the process we are talking to is the old one and will
      // never answer: abandon this attempt and retry against the new daemon.
      // (A replacement socket file has a different inode, so a fast new daemon is caught too.)
      const inode = (): number | null => {
        try { return statSync(socketPath).ino; } catch { return null; }
      };
      const ino0 = inode();
      watch = setInterval(() => {
        if (connected && inode() !== ino0) retry("daemon socket replaced or removed while waiting (daemon restarting)");
      }, 250);

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        let response: IpcResponse;
        try {
          response = JSON.parse(line) as IpcResponse;
        } catch {
          finish(new Error(`IPC parse error: ${line}`));
          return;
        }

        if (!response.ok) {
          const msg = response.error ?? "IPC call failed";
          if (/daemon is restarting/i.test(msg)) retry(msg, true);
          else finish(new Error(msg));
        } else {
          finish(null, response.result);
        }
      });

      socket.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ECONNREFUSED" || e.code === "ECONNRESET" || e.code === "EPIPE") {
          retry(`${e.code} on ${socketPath}`, !connected && (e.code === "ENOENT" || e.code === "ECONNREFUSED"));
        } else {
          finish(e);
        }
      });

      socket.on("end", () => retry("connection closed before response"));
      socket.on("close", () => retry("connection closed before response"));

      timer = setTimeout(() => {
        finish(new Error(`IPC call ${method} timed out after ${timeoutMs}ms (PAI daemon may be restarting or overloaded)`));
      }, timeoutMs);
    });
  }
}
