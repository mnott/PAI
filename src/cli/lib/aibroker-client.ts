/**
 * aibroker-client.ts — Lightweight IPC client for AIBroker daemon.
 *
 * Connects to the AIBroker Unix Domain Socket, sends a JSON-RPC request,
 * and reads a single newline-terminated JSON response. No class needed —
 * just a thin async function matching the WatcherClient protocol.
 *
 * Socket path: /tmp/aibroker.sock (default; override via AIBROKER_SOCKET env).
 */

import { connect } from "node:net";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lightweight session metadata returned by the AIBroker `sessions` IPC method.
 * Does NOT include scrollback content — use `session_content` for that.
 */
export interface AiBrokerSessionMeta {
  index: number;
  sessionId: string;
  /** iTerm2 tab title or profile name */
  name: string;
  /** PAI session name set via /Name; null for bare shells */
  paiName: string | null;
  atPrompt: boolean;
  /** "claude" for Claude Code panes, "shell" for bare terminals */
  kind: "claude" | "shell";
  /** Whether this is the currently focused pane */
  active: boolean;
}

interface AiBrokerSessionsResult {
  sessions: AiBrokerSessionMeta[];
}

// ---------------------------------------------------------------------------
// Core call
// ---------------------------------------------------------------------------

const DEFAULT_SOCKET = process.env.AIBROKER_SOCKET ?? "/tmp/aibroker.sock";

/**
 * Call an AIBroker IPC method and return the result.
 *
 * Resolves with the `result` field of a successful response.
 * Rejects if the socket is not available, the call times out, or the
 * daemon returns an error.
 *
 * @param method   IPC method name (e.g. "session_content", "send_to_session")
 * @param params   Method parameters object
 * @param timeoutMs  Connection + response timeout in milliseconds (default: 8 000)
 */
export function callAiBroker(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 8_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socketPath = DEFAULT_SOCKET;
    let done = false;
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(err: Error | null, value?: Record<string, unknown>): void {
      if (done) return;
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value!);
    }

    const socket = connect(socketPath, () => {
      const request = {
        id: randomUUID(),
        sessionId: process.env.TERM_SESSION_ID ?? "pai-cli",
        method,
        params,
      };
      const itermId = process.env.ITERM_SESSION_ID;
      if (itermId) Object.assign(request, { itermSessionId: itermId });
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl);

      let response: { ok: boolean; result?: Record<string, unknown>; error?: string };
      try {
        response = JSON.parse(line);
      } catch {
        finish(new Error(`AIBroker IPC parse error: ${line.slice(0, 120)}`));
        return;
      }

      if (!response.ok) {
        finish(new Error(response.error ?? "AIBroker IPC call failed"));
      } else {
        finish(null, response.result ?? {});
      }
    });

    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        finish(new Error("AIBroker not running (socket not found)."));
      } else {
        finish(e);
      }
    });

    socket.on("end", () => {
      if (!done) finish(new Error("AIBroker IPC connection closed before response."));
    });

    timer = setTimeout(
      () => finish(new Error("AIBroker IPC call timed out.")),
      timeoutMs
    );
  });
}

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all live iTerm2 session metadata from AIBroker via the `sessions` method.
 * Returns an empty array if AIBroker is not running.
 *
 * This is metadata-only (no scrollback). It is faster than `session_content`
 * and the correct source for listing/routing purposes.
 */
export async function fetchLiveSessions(): Promise<AiBrokerSessionMeta[]> {
  try {
    const result = await callAiBroker("sessions", {});
    const sessions = (result as unknown as AiBrokerSessionsResult).sessions;
    if (!Array.isArray(sessions)) return [];
    return sessions;
  } catch {
    return [];
  }
}

/**
 * Send text to a specific AIBroker session by its iTerm2 sessionId.
 */
export async function sendToSession(
  sessionId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await callAiBroker("send_to_session", { sessionId, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
