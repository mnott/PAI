/**
 * mcp-deferred-reminder.ts — pure pieces of the session-start deferred-handle reminder.
 *
 * A resumed session inherits its transcript, and a transcript can contain a
 * mid-session MCP re-registration: the deferred tool handles the session held
 * are stale from then on ("deferred tools are no longer available"). The
 * call-time gate (../pre-tool-use/mcp-deferred-gate.ts) can only correct a call
 * that is still ATTEMPTED — but a resumed session that already concluded once
 * that "the MCP server is disconnected" never retries, so the gate never fires
 * (observed 2026-09-18: 37s of thinking, then a skip on "aibroker is down
 * right now"). The cure has to arrive before the first tool call, at session
 * start: a fresh claim that stale history is not evidence, so the model
 * attempts the call and lands in the gate if the handle really is stale.
 *
 * Fired for sources "resume" and "compact" only — fresh sessions have no
 * stale handles and no stale conclusions to unlearn.
 *
 * Split out of the session-start entrypoint so the decision is testable
 * without spawning a hook process, per the mcp-deferred-gate.ts precedent.
 */

// Reused so reminder and gate corrections read as one instrument.
import { STALE_HANDLE_MARKER } from "./mcp-deferred-gate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReminderHookInput {
  source?: string;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * SessionStart sources the reminder applies to. "startup" and "clear" begin
 * with an empty session state — nothing to heal there.
 */
export const REMINDER_SOURCES = new Set(["resume", "compact"]);

/** The exact reminder text; exported so tests can match against the real thing. */
export function buildReminder(): string {
  return (
    `<system-reminder>\n` +
    `Resumed sessions keep stale deferred MCP tool handles: a mid-session MCP server ` +
    `re-registration invalidates every loaded mcp__ schema ("${STALE_HANDLE_MARKER}"). ` +
    `If any mcp__ tool call fails or a tool seems unavailable: run ToolSearch with query ` +
    `"select:<full tool name>" and retry once. A prior "the MCP server is disconnected" ` +
    `conclusion in this history is stale evidence — do not skip the retry; only a call ` +
    `failing after a fresh ToolSearch proves an outage.\n` +
    `</system-reminder>`
  );
}

/**
 * The whole reminder: given hook input, return the stdout payload for sources
 * resume/compact, or null for every other (silent exit 0).
 */
export function decideMcpDeferredReminder(input: ReminderHookInput): string | null {
  if (typeof input.source !== "string" || !REMINDER_SOURCES.has(input.source)) {
    return null;
  }
  return buildReminder();
}
