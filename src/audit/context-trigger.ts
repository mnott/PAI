/**
 * context-trigger.ts — the window size and compaction trigger a SPECIFIC
 * session transcript actually runs against, instead of a constant assumed
 * for every session.
 *
 * Run 4 of the token-waste audit (audits/token-waste/2026-09-20-run4.md)
 * rated a 1M-window session against a hardcoded 200k threshold, read the
 * resulting RED "context growth" finding at face value, and lowered
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE to make the 1M session compact near 196k —
 * the opposite of what the 1M window exists for. See
 * audits/token-waste/reviewprompt.md, "Rules the audit may not break".
 *
 * Reuses, rather than re-implements, the same derivation the compaction-
 * handover hook uses (src/hooks/ts/lib/context-fill.ts) so the audit and the
 * hook can never disagree about what "the trigger" for a session is.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DEFAULT_CONTEXT_WINDOW, contextWindowFromModelId } from "../utils/model-window.js";
import {
  contextFillFromTranscript,
  contextFillThresholds,
  readStatuslineFill,
  statuslineStateFilePath,
  type ContextFillReading,
  type TriggerSource,
} from "../hooks/ts/lib/context-fill.js";

const TAIL_LINES = 40;

/**
 * Where the session's context WINDOW SIZE came from, in the order they are
 * tried:
 *
 *   1. "statusline-state": the statusline's own persisted reading for this
 *      session id, fresh (written within the last 5 minutes) — see
 *      readStatuslineFill.
 *   2. "statusline-state-stale": the same file, older than 5 minutes —
 *      accepted for an audit run well after the session ended, because a
 *      session's window does not change after launch; a stale window number
 *      is not the same defect a stale FILL number would be.
 *   3. "transcript-field": a `context_window` field on a recent transcript
 *      line (checked before the model id, since it would be the platform's
 *      own number — no transcript on this project carries it as of
 *      2026-09-20, but a future platform version might).
 *   4. "model-id": the last assistant model id in the transcript carries a
 *      bracketed window variant ("claude-fable-5-1[1m]" -> 1,000,000).
 *   5. "compaction-history": this transcript's OWN compact_boundary events
 *      recorded a preTokens reading above the 200k default — proof the
 *      window is at least that large, rounded up to the nearest whole
 *      million (in practice 1,000,000). Catches exactly the fault this
 *      module exists to fix: a live 1M-window session whose transcript
 *      stores the bare model id, with no fresh or stale statusline file to
 *      fall back on.
 *   6. "default": DEFAULT_CONTEXT_WINDOW (200,000) — nothing above applied.
 */
export type WindowSource =
  | "statusline-state"
  | "statusline-state-stale"
  | "transcript-field"
  | "model-id"
  | "compaction-history"
  | "default";

/** "override": `--ctx-threshold` was passed explicitly, bypassing derivation
 *  entirely — added to context-fill.ts's own TriggerSource values, which
 *  describe only the measured-vs-configured choice inside derivation. */
export type SessionTriggerSource = TriggerSource | "override";

export interface DerivedTrigger {
  window: number;
  windowSource: WindowSource;
  trigger: number;
  autocompactPct: number;
  triggerSource: TriggerSource;
}

function readTranscript(transcriptPath: string): string | null {
  try {
    return readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * A `context_window` field on a transcript line, when the platform ever
 * writes one — see WindowSource, step 3.
 */
function contextWindowFromTranscriptField(transcriptPath: string): number | null {
  const raw = readTranscript(transcriptPath);
  if (raw === null) return null;
  const lines = raw.trim().split("\n").filter((l) => l.trim());
  const tail = lines.slice(-TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    let entry: { context_window?: unknown; message?: { context_window?: unknown } };
    try {
      entry = JSON.parse(tail[i]);
    } catch {
      continue;
    }
    const value = entry.context_window ?? entry.message?.context_window;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** The last assistant `message.model` id in the transcript, scanned from the
 *  tail — see WindowSource, step 4. */
function lastAssistantModelId(transcriptPath: string): string | null {
  const raw = readTranscript(transcriptPath);
  if (raw === null) return null;
  const lines = raw.trim().split("\n").filter((l) => l.trim());
  const tail = lines.slice(-TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { model?: unknown } };
    try {
      entry = JSON.parse(tail[i]);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const model = entry.message?.model;
    if (typeof model === "string" && model !== "") return model;
  }
  return null;
}

/**
 * The largest `compactMetadata.preTokens` this transcript's own
 * compact_boundary events recorded, rounded up to the nearest whole million
 * — see WindowSource, step 5. Reads the WHOLE transcript (not just the tail):
 * a compaction event can sit anywhere in a long session's history, unlike
 * the model id / context_window checks above, which only ever need the most
 * recent turn.
 */
function windowFromCompactionHistory(transcriptPath: string): number | null {
  const raw = readTranscript(transcriptPath);
  if (raw === null) return null;
  let maxPreTokens = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; subtype?: string; compactMetadata?: { preTokens?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "system" || entry.subtype !== "compact_boundary") continue;
    const preTokens = entry.compactMetadata?.preTokens;
    if (typeof preTokens === "number" && Number.isFinite(preTokens) && preTokens > maxPreTokens) {
      maxPreTokens = preTokens;
    }
  }
  if (maxPreTokens <= DEFAULT_CONTEXT_WINDOW) return null;
  return Math.ceil(maxPreTokens / 1_000_000) * 1_000_000;
}

/**
 * The statusline state file for a session id, read WITHOUT the 5-minute
 * staleness gate readStatuslineFill applies — WindowSource step 2. Reuses
 * readStatuslineFill itself (rather than re-parsing the file) by handing it
 * back the file's own timestamp as "now", so the freshness check it performs
 * internally always computes a zero age; every other validation (shape,
 * numeric fields) stays exactly as readStatuslineFill enforces it.
 */
function readStatuslineFillIgnoringStaleness(sessionId: string): ContextFillReading | null {
  const path = statuslineStateFilePath(sessionId);
  const raw = readTranscript(path);
  if (raw === null) return null;
  let parsed: { timestamp?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.timestamp !== "number") return null;
  return readStatuslineFill(sessionId, parsed.timestamp);
}

/**
 * The transcript's own project directory, as Claude Code encodes it under
 * `~/.claude/projects/<encoded-cwd>/` — recovered from the transcript's PATH
 * rather than accepted as a caller-supplied cwd, so the measured-trigger
 * history scan is always scoped to the transcript's OWN project, never the
 * auditing process's process.cwd() (a real fault: an audit of another
 * project's transcript logged "measured trigger for <this process's cwd>").
 *
 * An already-encoded directory NAME contains no `/`, whitespace or `.` — the
 * only characters encodeProjectPath (context-fill.ts) folds into `-` — so
 * re-encoding it is a no-op, and handing this name back as the `cwd` argument
 * to contextFillThresholds/measureCompactionTrigger reproduces the exact
 * directory via their own `join(projectsDir, encodeProjectPath(cwd))`, with
 * no changes needed there. A transcript inside Claude Code's `sessions/`
 * archive sits one level deeper than the live transcript, so its directory
 * name is one level further up.
 */
function projectDirNameFromTranscript(transcriptPath: string): string {
  const dir = dirname(transcriptPath);
  return basename(dir) === "sessions" ? basename(dirname(dir)) : basename(dir);
}

/**
 * window: resolved via WindowSource's steps in order — never a window
 * assumed regardless of the session.
 *
 * trigger: contextFillThresholds's effectiveTriggerTokens for that window —
 * this transcript's own project's measured compact_boundary history when it
 * has any (the better estimate), else resolveAutocompactPct(env) applied to
 * the window.
 */
export function deriveSessionTrigger(
  transcriptPath: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): DerivedTrigger {
  const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "");

  let window: number;
  let windowSource: WindowSource;

  const fresh = readStatuslineFill(sessionId, now);
  const stale = fresh ? null : readStatuslineFillIgnoringStaleness(sessionId);
  const fieldWindow = fresh || stale ? null : contextWindowFromTranscriptField(transcriptPath);
  const modelWindow =
    fresh || stale || fieldWindow !== null
      ? null
      : contextWindowFromModelId(lastAssistantModelId(transcriptPath));
  const compactionWindow =
    fresh || stale || fieldWindow !== null || modelWindow !== null
      ? null
      : windowFromCompactionHistory(transcriptPath);

  if (fresh) {
    window = fresh.windowSize;
    windowSource = "statusline-state";
  } else if (stale) {
    window = stale.windowSize;
    windowSource = "statusline-state-stale";
  } else if (fieldWindow !== null) {
    window = fieldWindow;
    windowSource = "transcript-field";
  } else if (modelWindow !== null) {
    window = modelWindow;
    windowSource = "model-id";
  } else if (compactionWindow !== null) {
    window = compactionWindow;
    windowSource = "compaction-history";
  } else {
    window = DEFAULT_CONTEXT_WINDOW;
    windowSource = "default";
  }

  const reading = contextFillFromTranscript(transcriptPath, window);
  const thresholds = contextFillThresholds(reading, env, { cwd: projectDirNameFromTranscript(transcriptPath) });

  return {
    window,
    windowSource,
    trigger: thresholds.effectiveTriggerTokens,
    autocompactPct: thresholds.autocompactPct,
    triggerSource: thresholds.triggerSource,
  };
}

export { DEFAULT_CONTEXT_WINDOW };
