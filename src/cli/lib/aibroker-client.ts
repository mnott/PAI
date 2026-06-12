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
import { spawnSync } from "node:child_process";

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
  /** Last user prompt seen in scrollback (only populated by fetchLiveSessionsWithPrompts) */
  lastPrompt?: string;
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
 * Fetch live sessions WITH the last user prompt extracted from terminal scrollback.
 *
 * Heavier than `fetchLiveSessions` (one IPC call returning full content for
 * every session), but yields a `lastPrompt` field useful for the unified
 * listing.
 */
export async function fetchLiveSessionsWithPrompts(): Promise<
  (AiBrokerSessionMeta & { lastPrompt?: string })[]
> {
  // Get the basic metadata first (always works, fast).
  const metas = await fetchLiveSessions();
  if (metas.length === 0) return [];

  // Then enrich with last prompts via session_content (single call, all sessions).
  try {
    const contentResult = (await callAiBroker("session_content", { lines: 60 })) as {
      sessions?: Array<{ sessionId: string; content?: string }>;
    };
    const contentMap = new Map<string, string>();
    for (const s of contentResult.sessions ?? []) {
      if (s.sessionId && typeof s.content === "string") {
        contentMap.set(s.sessionId, s.content);
      }
    }
    return metas.map((m) => {
      const content = contentMap.get(m.sessionId);
      const lastPrompt = content ? extractLastUserPrompt(content) : undefined;
      return { ...m, lastPrompt };
    });
  } catch {
    return metas.map((m) => ({ ...m }));
  }
}

/**
 * Extract the most-recent user prompt from a terminal scrollback string.
 *
 * Claude Code's TUI shows user input lines prefixed with `❯ `. We scan from
 * the bottom up, skipping the active input box (between the two horizontal
 * rule lines) and the statusline footer.
 */
function extractLastUserPrompt(content: string): string | undefined {
  const lines = content.split("\n");
  // Walk bottom-up looking for the most recent user-typed line.
  // Claude Code marks user prompts with one of these prefixes:
  //   ❯ <text>      (current/recent prompt in the input box or scrollback)
  //   > <text>      (older variant)
  // The line MUST have non-empty content after the prompt symbol.
  // Skip the active input box (often empty `❯`) and statusline (👋 PAI CC...).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // Match ❯ or > (followed by space) then content
    const m = line.match(/^[❯>]\s+(.+?)\s*$/);
    if (!m) continue;
    let text = m[1].trim();
    if (!text) continue;
    // Skip lines that are just box-drawing or known UI noise
    if (/^[─━═]+/.test(text)) continue;
    if (text.startsWith("👋")) continue;
    // Strip ANSI escape sequences that may leak in
    text = text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").trim();
    if (text) return text;
  }
  return undefined;
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

/**
 * Switch iTerm2 focus to the session identified by `target`.
 *
 * `target` can be a sessionId, paiName, or tab index number (as string).
 * After switching, activates the iTerm2 application itself so the window
 * comes to the foreground.
 *
 * Returns { ok: true } if AIBroker confirmed the switch, or
 * { ok: false, error } if AIBroker is not running or the session was not found.
 */
export async function switchToSession(target: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await callAiBroker("switch", { target });
    // Bring iTerm2 itself to the foreground (the IPC only selects the tab)
    const { spawnSync } = await import("node:child_process");
    spawnSync("osascript", ["-e", 'tell application "iTerm" to activate'], {
      stdio: "ignore",
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Bring the iTerm2 tab containing a specific session to the front.
 *
 * This is the mechanism AIBroker's screenshot path uses: match the session by
 * its iTerm2 session id (the `sessionId` returned by `fetchLiveSessions`, which
 * is iTerm's own `id of session`), then `select` its window, tab, and session.
 * Unlike the `switch` IPC (which only flips an internal index and never touches
 * iTerm), this actually reveals the tab.
 */
export function revealItermSession(itermSessionId: string): { ok: boolean; error?: string } {
  // Strip any "iterm:" style prefix, matching AIBroker's stripItermPrefix.
  const id = itermSessionId.replace(/^iterm:/i, "").trim();
  const script = `tell application "iTerm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${id}" then
          select w
          select t
          select s
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not-found"
end tell`;
  try {
    const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    if (r.status !== 0) {
      return { ok: false, error: (r.stderr || "osascript failed").trim() };
    }
    if ((r.stdout ?? "").trim() === "ok") return { ok: true };
    return { ok: false, error: "session not found in any iTerm2 window" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
