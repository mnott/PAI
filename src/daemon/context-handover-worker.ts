/**
 * context-handover-worker.ts — the threshold-triggered pre-compaction
 * handover.
 *
 * `session-summary-worker.ts` already spawns a model to write session notes,
 * but only from the PreCompact hook itself — which fires at the compaction
 * boundary, far too late to be injected INTO that same compaction's
 * post-compact context. This worker runs earlier, off a token-count
 * threshold (see ../hooks/ts/lib/context-fill.ts), so a model-written
 * handover already exists in a cache file by the time compaction happens.
 *
 * Deliberately narrow: this does not write a session note, does not touch
 * the session-summary cooldown file, and does not run KG extraction. It
 * writes one thing — a cache file the PreCompact hook can read — because its
 * only job is to exist before compaction does, not to duplicate what
 * session-summary-worker already does well.
 *
 * The prompt itself (see templates/context-handover-prompt.ts) treats the
 * handover as a DIFF against everything already durable — git, the tracker,
 * the notes — not a session summary, and a refresh run carries the previous
 * cached handover forward rather than overwriting it.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  findLatestJsonl,
  getGitContext,
  spawnSummarizer,
  contentToText,
} from "./session-summary-worker.js";
import { buildContextHandoverPrompt } from "./templates/context-handover-prompt.js";
import {
  readContextHandoverCache,
  writeContextHandoverCache,
  type HandoverThreshold,
} from "../hooks/ts/lib/context-handover-cache.js";

export type { HandoverThreshold } from "../hooks/ts/lib/context-handover-cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextHandoverPayload {
  cwd: string;
  sessionId: string;
  transcriptPath?: string;
  threshold: HandoverThreshold;
  /** True when this fired via the "no time for a clean crossing" path
   *  (see isImmediate in context-fill.ts) — logged, not otherwise acted on. */
  urgent?: boolean;
}

/** How much of the tail of the transcript to feed the summarizer. Generous —
 *  this runs at most twice per session, not on every tool call. */
const MAX_TURN_CHARS = 150_000;

/** Max turns to include (a hard floor even if MAX_TURN_CHARS is not hit). */
const MAX_TURNS = 120;

// ---------------------------------------------------------------------------
// Transcript → turns
// ---------------------------------------------------------------------------

/**
 * Interleaved "User:"/"Assistant:" turns, oldest-kept-from-the-end so a long
 * transcript is truncated to its most recent content rather than its
 * earliest. Unlike session-summary-worker's extractFromJsonl (which keeps
 * only user messages, because a session note doesn't need the assistant's
 * own reasoning) this keeps BOTH sides — the whole point of this prompt is
 * the assistant's reasoning, which lives in assistant turns.
 */
function extractTurns(jsonlPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
  }

  if (raw.length > MAX_TURN_CHARS) {
    const truncPoint = raw.indexOf("\n", raw.length - MAX_TURN_CHARS);
    raw = truncPoint >= 0 ? raw.slice(truncPoint + 1) : raw.slice(-MAX_TURN_CHARS);
  }

  const turns: string[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "user") {
      const msg = entry.message as Record<string, unknown> | undefined;
      const text = contentToText(msg?.content);
      if (text && text.length >= 3 && !text.startsWith("<system-reminder>")) {
        turns.push(`User: ${text.slice(0, 2000)}`);
      }
    } else if (entry.type === "assistant") {
      const msg = entry.message as Record<string, unknown> | undefined;
      const text = contentToText(msg?.content);
      if (text && text.length >= 3) {
        turns.push(`Assistant: ${text.slice(0, 4000)}`);
      }
    }
  }

  return turns.slice(-MAX_TURNS);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process a `context-handover` work item. Best-effort throughout: a failed
 * or empty summarizer run logs and returns without writing a cache file —
 * never overwrites a previously good cache with nothing, and never throws
 * (the work queue would otherwise retry a job whose only cost is an LLM
 * call nobody is waiting on).
 */
export async function handleContextHandover(payload: ContextHandoverPayload): Promise<void> {
  const { cwd, sessionId, transcriptPath, threshold, urgent } = payload;

  if (!cwd || !sessionId) {
    process.stderr.write("[context-handover] payload missing cwd or sessionId — skipping.\n");
    return;
  }

  process.stderr.write(
    `[context-handover] Starting for ${cwd} (session=${sessionId}, threshold=${threshold}` +
    `${urgent ? ", urgent" : ""}).\n`
  );

  let jsonlPath: string | null = transcriptPath && existsSync(transcriptPath) ? transcriptPath : null;
  if (!jsonlPath) jsonlPath = findLatestJsonl(cwd);
  if (!jsonlPath) {
    process.stderr.write("[context-handover] No transcript found — skipping.\n");
    return;
  }

  const turns = extractTurns(jsonlPath);
  if (turns.length === 0) {
    process.stderr.write("[context-handover] No turns extracted — skipping.\n");
    return;
  }

  const gitLog = await getGitContext(cwd);

  // Carry the previous handover forward (see buildContextHandoverPrompt's
  // scoping rule) rather than silently overwriting it — a refresh at the
  // second threshold should not lose what the warmup handover already
  // captured.
  const previous = readContextHandoverCache(sessionId);
  const prompt = buildContextHandoverPrompt({
    turns,
    gitLog,
    cwd,
    previousHandover: previous?.summary,
  });
  process.stderr.write(`[context-handover] Sending ${prompt.length} char prompt to sonnet...\n`);

  const summary = await spawnSummarizer(prompt, "sonnet");
  if (!summary || !summary.trim()) {
    process.stderr.write("[context-handover] sonnet produced no output — leaving any existing cache untouched.\n");
    return;
  }

  writeContextHandoverCache({
    sessionId,
    cwd,
    threshold,
    generatedAt: new Date().toISOString(),
    model: "sonnet",
    summary: summary.trim(),
  });

  process.stderr.write(
    `[context-handover] Wrote cache for session ${sessionId} (${summary.length} chars).\n`
  );
}
