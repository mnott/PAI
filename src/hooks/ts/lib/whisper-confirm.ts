/**
 * whisper-confirm.ts — marker for the whisper rules confirm-once rule.
 *
 * The rule "After every new session or compact, confirm you read the Whispr
 * rules." asks for ONE confirmation per session life, but whisper-rules.ts
 * injects the rule file on every UserPromptSubmit — so every session echoed
 * "Whispr rules read" on every response. The fix is a per-session marker
 * file in tmpdir(), the same pattern as the reinject counter in
 * user-prompt/whisper-rules.ts: the first prompt that injects the line
 * writes the marker, later prompts see it and drop just that line.
 *
 * A compact keeps the session_id, so SessionStart(compact)
 * (session-start/post-compact-inject.ts) clears the marker and the first
 * prompt after a compact re-injects the line once. A new session gets a new
 * session_id, hence a fresh marker path — nothing to clear there.
 *
 * Lives in lib/ (not in whisper-rules.ts itself) because that file calls
 * main() at module scope and cannot be imported; post-compact-inject.ts
 * needs the clear function.
 */

import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { paiHomePath } from "../../../config/pai-home.js";

/** The rule line to gate, matched by prefix so wording tweaks after the
 *  prefix do not silently re-enable per-prompt injection. */
export const CONFIRM_RULE_PREFIX = "After every new session or compact, confirm";

export function whisperConfirmMarkerPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "nosession";
  return paiHomePath("state", "whisper-confirm", safe);
}

/**
 * True when this session already had the confirm line injected. A missing
 * session_id can never match a marker, so malformed stdin keeps today's
 * output (the line stays in) instead of being silenced forever.
 */
export function confirmAlreadyInjected(sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    return existsSync(whisperConfirmMarkerPath(sessionId));
  } catch {
    return false;
  }
}

/** Record that the confirm line went out for this session — best effort. */
export function markConfirmInjected(sessionId: string): void {
  if (!sessionId) return;
  try {
    const f = whisperConfirmMarkerPath(sessionId);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(Math.floor(Date.now() / 1000)), "utf8");
  } catch { /* best effort — a repeated confirm line is not worth failing the hook over */ }
}

/** Forget the confirmation (SessionStart/compact) so the next prompt
 *  re-injects the line once — best effort. */
export function clearWhisperConfirmMarker(sessionId: string): void {
  if (!sessionId) return;
  try {
    const f = whisperConfirmMarkerPath(sessionId);
    if (existsSync(f)) unlinkSync(f);
  } catch { /* best effort */ }
}
