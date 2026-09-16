/**
 * context-fill.ts — "how full is this session's context window, right now?"
 *
 * No hook payload carries this number directly (verified: PreCompact,
 * UserPromptSubmit and PostToolUse stdin never include `context_window`).
 * Two sources can reconstruct it, in order of preference:
 *
 *   1. STATUSLINE STATE FILE — statusline-command.sh receives the exact
 *      figure from Claude Code (`.context_window.used_percentage` /
 *      `.context_window.context_window_size`) on every render and persists
 *      it to `${TMPDIR}/pai-context-<session_id>.json`. This is authoritative
 *      but depends on the status line having rendered recently — a session
 *      whose terminal isn't drawing a status line (headless, backgrounded)
 *      leaves this file missing or stale.
 *
 *   2. TRANSCRIPT USAGE — every `message.usage` entry in the session's own
 *      .jsonl transcript already reports the token accounting for that one
 *      API call: `input_tokens + cache_read_input_tokens +
 *      cache_creation_input_tokens` on the MOST RECENT such entry *is* the
 *      current context fill, because each request resends the full context.
 *      This is why it must be the last entry's fields summed, never a sum
 *      across entries — summing across entries is a running token-spend
 *      total, not a fill reading (see calculateSessionTokens, a different
 *      metric answering a different question).
 *
 * When neither source is available, the answer is UNKNOWN, not zero. A zero
 * reads as "plenty of room" and would silently suppress every downstream
 * decision that depends on this number (the compaction handover chief among
 * them) for the entire session.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Fallback window size when nothing on hand reports one. Matches the
 *  default statusline-command.sh already falls back to. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** How many trailing lines of the transcript to scan for a usage entry.
 *  A single turn is rarely more than a handful of JSONL lines (assistant
 *  text + tool_use/tool_result pairs), so 40 comfortably covers one turn
 *  even a busy one, without reading the whole file on every check. */
const TRANSCRIPT_TAIL_LINES = 40;

/** A statusline reading older than this is treated as not there at all —
 *  a stale number is worse than none, because it looks confident. */
const STATUSLINE_STALE_MS = 5 * 60 * 1000; // 5 minutes

export type ContextFillSource = "statusline" | "transcript" | "unknown";

export interface ContextFillReading {
  status: "ok" | "unknown";
  /** Tokens currently occupying the context window, or null when unknown. */
  usedTokens: number | null;
  windowSize: number;
  /** usedTokens / windowSize, or null when unknown. Not clamped to [0,1] —
   *  callers that need a clamped display value do that themselves so the
   *  raw reading (which can legitimately exceed 1 for a moment) is never
   *  silently rewritten here. */
  fraction: number | null;
  source: ContextFillSource;
}

function unknownReading(windowSize: number): ContextFillReading {
  return { status: "unknown", usedTokens: null, windowSize, fraction: null, source: "unknown" };
}

// ---------------------------------------------------------------------------
// Source 1 — statusline state file
// ---------------------------------------------------------------------------

export function statuslineStateFilePath(sessionId: string): string {
  return join(tmpdir(), `pai-context-${sessionId}.json`);
}

interface StatuslineState {
  used_percentage?: number;
  context_window_size?: number;
  session_id?: string;
  timestamp?: number;
}

/**
 * Read the state file statusline-command.sh writes on every render.
 * Returns null when the file is missing, unparsable, or older than
 * STATUSLINE_STALE_MS — all three mean "not a source right now".
 */
export function readStatuslineFill(sessionId: string, now = Date.now()): ContextFillReading | null {
  if (!sessionId) return null;
  const path = statuslineStateFilePath(sessionId);
  if (!existsSync(path)) return null;

  let raw: StatuslineState;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }

  if (typeof raw.timestamp !== "number" || now - raw.timestamp > STATUSLINE_STALE_MS) {
    return null; // stale — fall through to the transcript source
  }
  if (typeof raw.used_percentage !== "number" || typeof raw.context_window_size !== "number") {
    return null;
  }

  const windowSize = raw.context_window_size;
  const usedTokens = Math.round((raw.used_percentage / 100) * windowSize);
  return {
    status: "ok",
    usedTokens,
    windowSize,
    fraction: raw.used_percentage / 100,
    source: "statusline",
  };
}

// ---------------------------------------------------------------------------
// Source 2 — transcript usage (fallback)
// ---------------------------------------------------------------------------

interface UsageEntry {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Sum the three context-carrying fields of ONE usage object — never across
 * usage objects. A single `message.usage` already reports what that one API
 * call sent as context; adding another entry's numbers to it produces a
 * cumulative spend figure, not a fill reading, and can exceed the window
 * size many times over on a long session (the exact defect this helper
 * exists to not repeat — see the PreCompact header fix in the same change).
 */
function usageTotal(usage: UsageEntry): number {
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

/**
 * Derive context fill from the tail of a .jsonl transcript: the most recent
 * `message.usage` entry, read from the end backwards so a trailing line with
 * no usage field (a plain text turn, a tool_result) doesn't hide one just
 * before it.
 */
export function contextFillFromTranscript(
  transcriptPath: string,
  windowSize = DEFAULT_CONTEXT_WINDOW
): ContextFillReading {
  if (!transcriptPath || !existsSync(transcriptPath)) return unknownReading(windowSize);

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return unknownReading(windowSize);
  }

  const lines = raw.trim().split("\n").filter((l) => l.trim());
  const tail = lines.slice(-TRANSCRIPT_TAIL_LINES);

  for (let i = tail.length - 1; i >= 0; i--) {
    let entry: { message?: { usage?: UsageEntry } };
    try {
      entry = JSON.parse(tail[i]);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (usage && typeof usage === "object") {
      const usedTokens = usageTotal(usage);
      return {
        status: "ok",
        usedTokens,
        windowSize,
        fraction: usedTokens / windowSize,
        source: "transcript",
      };
    }
  }

  return unknownReading(windowSize);
}

// ---------------------------------------------------------------------------
// Precedence — statusline (fresh) > transcript > unknown
// ---------------------------------------------------------------------------

export function getContextFill(
  input: { sessionId?: string; transcriptPath?: string; windowSize?: number },
  now = Date.now()
): ContextFillReading {
  const windowSize = input.windowSize ?? DEFAULT_CONTEXT_WINDOW;

  if (input.sessionId) {
    const fromStatusline = readStatuslineFill(input.sessionId, now);
    if (fromStatusline) return fromStatusline;
  }

  if (input.transcriptPath) {
    return contextFillFromTranscript(input.transcriptPath, windowSize);
  }

  return unknownReading(windowSize);
}

// ---------------------------------------------------------------------------
// Display helper — clamp-and-flag rather than ever print an absurd number
// ---------------------------------------------------------------------------

export interface FillDisplay {
  /** e.g. "63k" or "unknown". Never a number larger than the window. */
  text: string;
  /** True when the raw reading exceeded the window size and had to be
   *  clamped — that reading was a bug, not a fill, and callers may want to
   *  log it even though the displayed text is already safe. */
  flagged: boolean;
}

export function formatContextFill(reading: ContextFillReading): FillDisplay {
  if (reading.status !== "ok" || reading.usedTokens === null) {
    return { text: "unknown", flagged: false };
  }

  let used = reading.usedTokens;
  let flagged = false;
  if (used > reading.windowSize) {
    flagged = true;
    used = reading.windowSize;
  }

  const text = used > 1000 ? `${Math.round(used / 1000)}k` : String(used);
  return { text: flagged ? `${text}+ (clamped — reading exceeded window)` : text, flagged };
}

// ---------------------------------------------------------------------------
// Threshold-triggered handover — WHEN to warm up / refresh the model-written
// summary ahead of a compaction.
// ---------------------------------------------------------------------------
//
// THE CONFIGURED VALUE DOES NOT PREDICT THE TRIGGER. CLAUDE_AUTOCOMPACT_
// PCT_OVERRIDE was 80 throughout, on this machine, across BOTH of the
// following regimes — the same configured number, two different truths:
//
//   2026-08-16 .. 2026-09-10   preTokens ~ 993,096 – 1,002,500  (~100% of a 1M window)
//   2026-09-12 .. 2026-09-15   preTokens ~   782,981 – 791,995  (~78-79% of a 1M window)
//
// A threshold derived only from the configured override was wrong for the
// second regime and would be wrong again the next time it moves — the
// config is not ground truth, it is what Claude Code claims it will honor.
//
// GROUND TRUTH IS ON DISK ALREADY: every real compaction writes a
// `compact_boundary` system event to the transcript with
// `compactMetadata.preTokens` — the platform's own count of context tokens
// immediately before IT compacted. `measureCompactionTrigger` scans a
// project's own transcripts for these and takes the MINIMUM of the most
// recent three (minimum, not mean: warm-up must fire before the earliest
// plausible boundary, not the average one). A project that has compacted
// before learns its own trigger and needs no code change when the regime
// moves again — the same derivation produced 998,508 pre-09-12 and ~784k
// after, from one unchanged formula.
//
// The configured chain — env override, then a default — is the fallback,
// used ONLY when a project has no compaction history yet:
//
//   effectiveTrigger = measured ?? (windowSize * (override ?? 80) / 100)
//
// DEFAULT IS 80, NOT 100, WHEN NOTHING IS KNOWN. 100 was considered — it
// matches the FIRST regime above — and rejected: the costs are asymmetric.
// Warming up too early wastes one summary; cheap, invisible. Warming up too
// late produces exactly the degraded successor session this feature exists
// to prevent. 80 is the conservative default until a project has its own
// measured history to correct it.
//
// Margins below the effective trigger are absolute tokens, sized against the
// largest single-turn context jump measured: 62,383 tokens (517,952 →
// 580,335, about 27 seconds). warmup sits 100k below the trigger —
// comfortably more than that jump, so a session cannot leap clean over
// warmup straight into a compaction in one turn; refresh at 40k below
// catches a session that sat above warmup for a while; fireNow at 15k below
// is "no time left for a clean crossing" and fires immediately rather than
// waiting for one.
export const DEFAULT_AUTOCOMPACT_PCT = 80;

/** How many of the most recent compact_boundary events to consider, and to
 *  take the minimum of. */
const MEASURED_TRIGGER_SAMPLE_SIZE = 3;

/** How many of a project's most-recently-modified transcripts to scan for
 *  compact_boundary events. compact_boundary events cluster in whichever
 *  files were touched most recently — a full-history scan would cost a lot
 *  for a long-lived project and buy nothing this doesn't already get from
 *  the last handful of files. */
const MEASURED_TRIGGER_MAX_FILES = 8;

export const THRESHOLD_MARGIN_TOKENS = {
  warmup: 100_000,
  refresh: 40_000,
  immediate: 15_000,
} as const;

// ---------------------------------------------------------------------------
// Measured trigger — scan a project's own transcript history for the
// platform's own compact_boundary events, ground truth over configuration.
// ---------------------------------------------------------------------------
//
// Deliberately re-implements the tiny bit of path encoding it needs (below)
// rather than importing project-utils/paths.ts's encodePath: that module
// chain ends in pai-paths.ts, which calls process.exit(1) if PAI_DIR does
// not resolve to an existing directory. context-fill.ts is specifically the
// module a hook falls back on when its environment is unreliable — pulling
// in a dependency that can kill the process on import would defeat that.
// Claude Code's transcript directory is a fixed, home-relative convention
// (~/.claude/projects/<encoded-cwd>/), not something PAI_DIR governs, so
// resolving it directly here is also just the more correct dependency, not
// only the safer one.

/** Real default — overridable per-call so tests never touch the user's
 *  actual ~/.claude/projects/ (a live directory this very session writes to). */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[/\s.-]/g, "-");
}

interface CompactBoundarySample {
  preTokens: number;
  timestampMs: number;
}

function listProjectTranscripts(cwd: string, projectsDir: string): string[] {
  const projectDir = join(projectsDir, encodeProjectPath(cwd));
  if (!existsSync(projectDir)) return [];

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const collect = (dir: string): void => {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = join(dir, entry);
      try {
        candidates.push({ path: full, mtimeMs: statSync(full).mtimeMs });
      } catch {
        // Unreadable — skip.
      }
    }
  };
  collect(projectDir);
  collect(join(projectDir, "sessions"));

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, MEASURED_TRIGGER_MAX_FILES).map((c) => c.path);
}

/**
 * Every compact_boundary sample found in a project's most-recently-modified
 * transcripts, newest first.
 */
function readCompactBoundarySamples(cwd: string, projectsDir: string): CompactBoundarySample[] {
  const samples: CompactBoundarySample[] = [];

  for (const path of listProjectTranscripts(cwd, projectsDir)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: {
        type?: string;
        subtype?: string;
        timestamp?: string;
        compactMetadata?: { preTokens?: number };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "system" || entry.subtype !== "compact_boundary") continue;
      const preTokens = entry.compactMetadata?.preTokens;
      if (typeof preTokens !== "number" || !Number.isFinite(preTokens)) continue;
      const timestampMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(timestampMs)) continue;
      samples.push({ preTokens, timestampMs });
    }
  }

  samples.sort((a, b) => b.timestampMs - a.timestampMs);
  return samples;
}

/**
 * The measured compaction trigger for a project, or null when it has no
 * compaction history yet (a brand-new project, or one whose transcripts
 * this process cannot read). Minimum of the most recent
 * MEASURED_TRIGGER_SAMPLE_SIZE compact_boundary events — see the module
 * comment above for why minimum, not mean.
 */
export function measureCompactionTrigger(
  cwd: string,
  projectsDir: string = CLAUDE_PROJECTS_DIR
): number | null {
  if (!cwd) return null;
  const samples = readCompactBoundarySamples(cwd, projectsDir).slice(0, MEASURED_TRIGGER_SAMPLE_SIZE);
  if (samples.length === 0) return null;
  return Math.min(...samples.map((s) => s.preTokens));
}

/**
 * Read CLAUDE_AUTOCOMPACT_PCT_OVERRIDE from the environment. Absent →
 * DEFAULT_AUTOCOMPACT_PCT. Present but not a finite number in (0, 100] →
 * also DEFAULT_AUTOCOMPACT_PCT, logged, so a typo in the override degrades
 * to the documented default instead of silently producing nonsense
 * thresholds (0, negative, or a fraction so large no session ever reaches
 * it).
 */
export function resolveAutocompactPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (raw === undefined || raw === "") return DEFAULT_AUTOCOMPACT_PCT;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    console.error(
      `[context-fill] CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="${raw}" is not a usable percentage — ` +
      `falling back to the default ${DEFAULT_AUTOCOMPACT_PCT}.`
    );
    return DEFAULT_AUTOCOMPACT_PCT;
  }
  return parsed;
}

/**
 * The two thresholds that actually fire a handover job. "immediate" is not a
 * third job — see `isImmediate` below — it only changes how urgently a
 * crossing of these two is treated.
 */
export type ThresholdName = "warmup" | "refresh";

/** Which basis actually produced effectiveTriggerTokens — reported so the
 *  number is checkable rather than trusted. */
export type TriggerSource = "measured" | "configured";

export interface ContextFillThresholds {
  warmupTokens: number;
  refreshTokens: number;
  immediateTokens: number;
  /** The derived compaction trigger these were measured back from. */
  effectiveTriggerTokens: number;
  /** The autocompact percentage from the configured chain — computed and
   *  reported even when `triggerSource` is "measured" (in which case it
   *  describes what the fallback WOULD have used, not what was used). */
  autocompactPct: number;
  /** "measured" when this project has compact_boundary history and that was
   *  used; "configured" when it fell back to the env-override/default chain. */
  triggerSource: TriggerSource;
  /** True when these were computed against a window size Claude Code itself
   *  reported (the statusline source). False when the window is only an
   *  assumed default (the transcript-fallback source never learns the real
   *  window size) — callers should log this: a threshold silently computed
   *  against the wrong basis is the same class of fault as printing a token
   *  count larger than the window. */
  windowConfirmed: boolean;
}

export interface ContextFillThresholdOpts {
  /** The session's project directory, used to look up its own compaction
   *  history for the measured trigger. Omit when unknown — falls back to
   *  the configured chain, same as a project with no history yet. */
  cwd?: string;
  /** Override the measured-trigger lookup instead of scanning transcripts —
   *  primarily for tests. `null` forces the configured fallback even when
   *  `cwd` is given; `undefined` (the default) does the real lookup. */
  measuredTrigger?: number | null;
}

/**
 * Derive warmup/refresh/immediate thresholds from a fill reading, preferring
 * this project's own measured compaction history over the configured
 * override chain — see the module comment above for why. Margins are
 * clamped at 0 (and logged) for a window small enough that a margin would
 * otherwise go negative — a pathological input should degrade to "fire
 * immediately", never to a threshold below zero.
 */
export function contextFillThresholds(
  reading: ContextFillReading,
  env: NodeJS.ProcessEnv = process.env,
  opts: ContextFillThresholdOpts = {}
): ContextFillThresholds {
  const windowConfirmed = reading.source === "statusline";
  const autocompactPct = resolveAutocompactPct(env);
  const configuredTriggerTokens = Math.round(reading.windowSize * (autocompactPct / 100));

  const measured = opts.measuredTrigger !== undefined
    ? opts.measuredTrigger
    : opts.cwd
      ? measureCompactionTrigger(opts.cwd)
      : null;

  const triggerSource: TriggerSource = measured !== null ? "measured" : "configured";
  const effectiveTriggerTokens = measured !== null ? measured : configuredTriggerTokens;

  if (triggerSource === "measured") {
    console.error(
      `[context-fill] trigger source: MEASURED — ${effectiveTriggerTokens} tokens ` +
      `(minimum of the most recent ${MEASURED_TRIGGER_SAMPLE_SIZE} compact_boundary events for ` +
      `this project; the configured chain would have given ${configuredTriggerTokens}).`
    );
  } else {
    console.error(
      `[context-fill] trigger source: CONFIGURED — no compaction history for this project yet, ` +
      `using ${effectiveTriggerTokens} tokens (${autocompactPct}% of a ${reading.windowSize}-token window).`
    );
  }

  const clamp = (name: string, value: number): number => {
    if (value >= 0) return value;
    console.error(
      `[context-fill] ${name} threshold went negative (${value}) for a ` +
      `${reading.windowSize}-token window — clamping to 0.`
    );
    return 0;
  };

  return {
    warmupTokens: clamp("warmup", effectiveTriggerTokens - THRESHOLD_MARGIN_TOKENS.warmup),
    refreshTokens: clamp("refresh", effectiveTriggerTokens - THRESHOLD_MARGIN_TOKENS.refresh),
    immediateTokens: clamp("immediate", effectiveTriggerTokens - THRESHOLD_MARGIN_TOKENS.immediate),
    effectiveTriggerTokens,
    autocompactPct,
    triggerSource,
    windowConfirmed,
  };
}

/**
 * Which named thresholds `usedTokens` has newly crossed, given the ones that
 * have already fired this session. Ascending order (warmup before refresh).
 *
 * A single check can return more than one name — e.g. a session first
 * observed at 99% of its window crosses warmup and refresh in the same tick,
 * because there was no earlier clean crossing to catch it at. That is the
 * "fire immediately" case: the caller enqueues one handover and marks every
 * newly-crossed name fired, rather than waiting for a crossing that already
 * happened.
 */
export function crossedThresholds(
  usedTokens: number,
  thresholds: ContextFillThresholds,
  alreadyFired: ThresholdName[]
): ThresholdName[] {
  const fired = new Set(alreadyFired);
  const ordered: Array<[ThresholdName, number]> = [
    ["warmup", thresholds.warmupTokens],
    ["refresh", thresholds.refreshTokens],
  ];
  return ordered.filter(([name, tokens]) => !fired.has(name) && usedTokens >= tokens).map(([name]) => name);
}

/**
 * True once a session is at or above the "no time left for a clean crossing"
 * floor (0.985 of the window). Purely informational for callers — it never
 * gates whether `crossedThresholds` fires (a poll-based check already fires
 * any unfired threshold the moment `usedTokens` reaches it, on whatever tick
 * observes it) — but it distinguishes "this crossed on schedule" from "this
 * was first observed already almost out of room", which is worth a different
 * log line and, for a caller that queues work, a higher priority.
 */
export function isImmediate(usedTokens: number, thresholds: ContextFillThresholds): boolean {
  return usedTokens >= thresholds.immediateTokens;
}
