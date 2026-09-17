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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONTEXT_WINDOW,
  contextWindowFromModelId,
  stripModelVariant,
} from "../../../utils/model-window.js";
import { readWorkersSection } from "../../../workers/config.js";

export { DEFAULT_CONTEXT_WINDOW };

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
 *
 * The window size, when the caller has none, is derived from the transcript's
 * own last assistant model id ("glm-5.3[1m]" → 1,000,000) before falling back
 * to the assumed default — a session whose model declares its window should
 * not be measured against a guess.
 */
export function contextFillFromTranscript(
  transcriptPath: string,
  windowSize?: number
): ContextFillReading {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return unknownReading(windowSize ?? DEFAULT_CONTEXT_WINDOW);
  }

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return unknownReading(windowSize ?? DEFAULT_CONTEXT_WINDOW);
  }

  const lines = raw.trim().split("\n").filter((l) => l.trim());
  const tail = lines.slice(-TRANSCRIPT_TAIL_LINES);

  // one pass from the end: the first usage entry is the fill reading, and the
  // last assistant model seen (before or at that point) declares the window
  let lastModel: string | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { usage?: UsageEntry; model?: unknown } };
    try {
      entry = JSON.parse(tail[i]);
    } catch {
      continue;
    }
    if (entry?.type === "assistant" && lastModel === null) {
      const model = entry.message?.model;
      if (typeof model === "string" && model !== "") lastModel = model;
    }
    const usage = entry?.message?.usage;
    if (usage && typeof usage === "object") {
      const window = windowSize ?? contextWindowFromModelId(lastModel) ?? DEFAULT_CONTEXT_WINDOW;
      const usedTokens = usageTotal(usage);
      return {
        status: "ok",
        usedTokens,
        windowSize: window,
        fraction: usedTokens / window,
        source: "transcript",
      };
    }
  }

  const window = windowSize ?? contextWindowFromModelId(lastModel) ?? DEFAULT_CONTEXT_WINDOW;
  return unknownReading(window);
}

// ---------------------------------------------------------------------------
// Precedence — statusline (fresh) > transcript > unknown
// ---------------------------------------------------------------------------

export function getContextFill(
  input: { sessionId?: string; transcriptPath?: string; windowSize?: number },
  now = Date.now()
): ContextFillReading {
  if (input.sessionId) {
    const fromStatusline = readStatuslineFill(input.sessionId, now);
    if (fromStatusline) return fromStatusline;
  }

  if (input.transcriptPath) {
    // windowSize passes through only when the caller knows it; otherwise the
    // transcript's own model id is asked first (see contextFillFromTranscript)
    return contextFillFromTranscript(input.transcriptPath, input.windowSize);
  }

  return unknownReading(input.windowSize ?? DEFAULT_CONTEXT_WINDOW);
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

export interface CompactBoundarySample {
  preTokens: number;
  timestampMs: number;
  /** ISO string, kept alongside timestampMs so callers can print it. */
  timestamp: string;
  /** The event's own uuid when present — the dedup key. Claude Code's
   *  `sessions/` archive directory mirrors the live project transcript, so
   *  the SAME compact_boundary event can legitimately appear in two files;
   *  without deduping by identity, "most recent three" can silently become
   *  three copies of one event, which is a stale reading wearing a
   *  plausible-looking sample size. */
  uuid?: string;
}

/** Every `.jsonl` transcript belonging to a project — top-level (the live
 *  file) and `sessions/` (Claude Code's archive, which mirrors it). No file
 *  is excluded and no ordering is applied here: ordering by EVENT
 *  timestamp, not by file mtime, is the whole point (see
 *  readCompactBoundarySamples) — a file's mtime does not reliably track
 *  which events inside it are recent, and pre-filtering by mtime is exactly
 *  what caused this function to return a stale, pre-regime-change trigger
 *  on real data. */
function listProjectTranscripts(cwd: string, projectsDir: string): string[] {
  const projectDir = join(projectsDir, encodeProjectPath(cwd));
  if (!existsSync(projectDir)) return [];

  const paths: string[] = [];
  const collect = (dir: string): void => {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) paths.push(join(dir, entry));
    }
  };
  collect(projectDir);
  collect(join(projectDir, "sessions"));
  return paths;
}

/** Placeholder model id the platform writes on synthetic assistant turns. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Which family of model wrote a transcript: a stable key derived from the id
 * itself, never from an Anthropic allowlist. "claude" is the platform's own;
 * any other id reduces to its base form before any bracketed variant suffix
 * ("glm-5.3[1m]" → "glm-5.3"), so the same model family always produces the
 * same key; "unknown" is no usable model field at all. Whether a family is
 * foreign is decided by comparison (see isForeignModelFamily), not by the
 * key — keying "foreign" here is what made non-Anthropic primary models lose
 * their own compaction history.
 */
export type TranscriptModelFamily = "claude" | "unknown" | (string & {});

export function modelFamily(model: string | null | undefined): TranscriptModelFamily {
  if (typeof model !== "string" || model === "" || model === SYNTHETIC_MODEL) return "unknown";
  const base = stripModelVariant(model);
  return base.startsWith("claude-") ? "claude" : base;
}

/**
 * Is a model id foreign to this machine's sessions? A model is native when it
 * is a Claude model or one the worker registry configures (any provider's
 * default or fast alias — the models this stack actually runs on). Anything
 * else, with a readable model id, is foreign. Doubt (no id, unreadable
 * registry) reads as native: the callers that skip work on "foreign" must not
 * skip it on doubt.
 */
export function isForeignModelFamily(
  family: TranscriptModelFamily,
  nativeFamilies?: Set<string>
): boolean {
  if (family === "unknown" || family === "claude") return false;
  return !(nativeFamilies ?? nativeModelFamilies()).has(family);
}

/** Families of every model id the worker registry configures. Never throws:
 *  an unreadable or missing registry means "nothing configured", which leaves
 *  every non-Claude family foreign — the historical behaviour. */
export function nativeModelFamilies(configPath?: string): Set<string> {
  const families = new Set<string>();
  try {
    for (const p of Object.values(readWorkersSection(configPath).workers.providers)) {
      families.add(modelFamily(p.models.default));
      if (p.models.fast) families.add(modelFamily(p.models.fast));
    }
  } catch {
    return families;
  }
  return families;
}

/**
 * The family of the LAST assistant model in a transcript — scanned from the
 * end so a long transcript costs one read and a few lines of parsing.
 * Unreadable or model-less transcripts are "unknown", never foreign:
 * the callers that skip work on foreign models must not skip it on doubt.
 * Pair with isForeignModelFamily to judge the key.
 */
export function transcriptModelFamily(path: string): TranscriptModelFamily {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return "unknown";
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"model"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
      if (entry.type !== "assistant") continue;
      const model = entry.message?.model;
      if (typeof model === "string" && model !== SYNTHETIC_MODEL) return modelFamily(model);
    } catch {
      continue;
    }
  }
  return "unknown";
}

/**
 * Every DISTINCT compact_boundary sample found across ALL of a project's
 * transcripts (live + archived), newest first by the event's OWN timestamp
 * — never by which file it came from or that file's mtime. Deduplicated by
 * the event's uuid (falling back to a timestamp+preTokens key for the rare
 * line with no uuid) so an event mirrored into `sessions/` is counted once.
 */
function readCompactBoundarySamples(
  cwd: string,
  projectsDir: string,
  nativeFamilies: Set<string>
): CompactBoundarySample[] {
  const byKey = new Map<string, CompactBoundarySample>();

  for (const path of listProjectTranscripts(cwd, projectsDir)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    // The model governing each sample: the most recent assistant
    // `message.model` seen in this file before the compact_boundary. A
    // transcript written by a model foreign to this machine (a headless
    // worker on another provider, with a different context window) compacts
    // at a different size and must not shape THIS project's trigger — two
    // such workers compacting at ~151k pulled a real project's trigger from
    // ~784k to ~151k. Native is Claude plus every model the registry
    // configures, so a non-Anthropic PRIMARY model keeps its own history.
    // Samples with no model seen yet are kept: older transcripts may lack
    // the field.
    let lastModel: string | null = null;
    let foreignDiscards = 0;

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: {
        type?: string;
        subtype?: string;
        timestamp?: string;
        uuid?: string;
        compactMetadata?: { preTokens?: number };
        message?: { model?: unknown };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "assistant") {
        const model = entry.message?.model;
        if (typeof model === "string" && model !== SYNTHETIC_MODEL) lastModel = model;
        continue;
      }
      if (entry.type !== "system" || entry.subtype !== "compact_boundary") continue;
      const preTokens = entry.compactMetadata?.preTokens;
      if (typeof preTokens !== "number" || !Number.isFinite(preTokens)) continue;
      const timestampMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(timestampMs)) continue;
      if (isForeignModelFamily(modelFamily(lastModel), nativeFamilies)) {
        foreignDiscards++;
        continue;
      }

      const key = entry.uuid ?? `${timestampMs}:${preTokens}`;
      if (!byKey.has(key)) {
        byKey.set(key, { preTokens, timestampMs, timestamp: entry.timestamp!, uuid: entry.uuid });
      }
    }

    if (foreignDiscards > 0) {
      console.error(
        `[context-fill] ignored ${foreignDiscards} compaction sample(s) from a ` +
        `foreign-model transcript (model=${lastModel}): ${path}`
      );
    }
  }

  return [...byKey.values()].sort((a, b) => b.timestampMs - a.timestampMs);
}

/**
 * The most recent MEASURED_TRIGGER_SAMPLE_SIZE distinct compact_boundary
 * events for a project, newest first — exposed on its own (not just the
 * derived minimum) so the number `measureCompactionTrigger` returns is
 * checkable: print these and the timestamps prove which three events
 * produced it, rather than asking for trust.
 */
export function selectedCompactionSamples(
  cwd: string,
  projectsDir: string = CLAUDE_PROJECTS_DIR,
  configPath?: string
): CompactBoundarySample[] {
  if (!cwd) return [];
  return readCompactBoundarySamples(cwd, projectsDir, nativeModelFamilies(configPath))
    .slice(0, MEASURED_TRIGGER_SAMPLE_SIZE);
}

/**
 * The measured compaction trigger for a project, or null when it has no
 * compaction history yet (a brand-new project, or one whose transcripts
 * this process cannot read). Minimum of the most recent
 * MEASURED_TRIGGER_SAMPLE_SIZE DISTINCT compact_boundary events, ordered by
 * the events' own timestamps across every transcript the project has
 * (live and archived) — see the module comment above for why minimum, not
 * mean, and readCompactBoundarySamples for why "distinct" and "own
 * timestamp" both matter (a file-mtime-ordered, non-deduplicated version of
 * this returned a stale pre-regime-change trigger on real project data).
 */
export function measureCompactionTrigger(
  cwd: string,
  projectsDir: string = CLAUDE_PROJECTS_DIR,
  configPath?: string
): number | null {
  const samples = selectedCompactionSamples(cwd, projectsDir, configPath);
  if (samples.length === 0) return null;
  const trigger = Math.min(...samples.map((s) => s.preTokens));
  console.error(
    `[context-fill] measured trigger for ${cwd}: ${trigger} (minimum of ` +
    samples.map((s) => `${s.preTokens}@${s.timestamp}`).join(", ") + ")"
  );
  return trigger;
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
export type TriggerSource = "measured" | "configured" | "measured-clamped";

export interface ContextFillThresholds {
  warmupTokens: number;
  refreshTokens: number;
  immediateTokens: number;
  /** The derived compaction trigger these were measured back from —
   *  min(measured, configured) when a measured value exists. */
  effectiveTriggerTokens: number;
  /** The raw measured value from this project's own compact_boundary
   *  history, before any clamping — null when the project has no history.
   *  Kept alongside effectiveTriggerTokens so a clamp is visible rather
   *  than silent: a caller can see both what was measured and what was
   *  actually used. */
  measuredTriggerTokens: number | null;
  /** The raw configured-chain value (env override or default, as a
   *  fraction of the window) — always computed and reported, even when it
   *  wasn't what ended up being used. */
  configuredTriggerTokens: number;
  /** The autocompact percentage from the configured chain. */
  autocompactPct: number;
  /** "measured": a measured value existed and was <= configured, so it was
   *  used directly — the better estimate, since it reflects reality the
   *  configured percentage cannot know.
   *  "measured-clamped": a measured value existed but was HIGHER than
   *  configured — it reflects a regime that may no longer apply (this
   *  project's last compaction predates a since-changed trigger), so the
   *  lower, safer configured value was used instead.
   *  "configured": no measured value exists yet (no compaction history for
   *  this project) — the configured chain is all there is. */
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
 * Derive warmup/refresh/immediate thresholds from a fill reading.
 *
 * effectiveTrigger = min(measured, configuredChainValue) when a measured
 * value exists — NOT the measured value outright. A project whose newest
 * compaction predates a regime change measures a stale-HIGH trigger: a real
 * case on this machine measured 998,267 for a project whose ACTUAL current
 * boundary (from a different project's fresher history, cross-checked
 * independently) is ~784,000 — using 998,267 directly would compute a
 * warm-up of 898,267, above the real boundary, so the handover would never
 * fire there. The measurement is honest; it is just old.
 *
 * The minimum is correct in both directions: the measured value is the
 * better estimate when it is LOWER than configured (it reflects reality the
 * configured percentage cannot know — see the module comment above, the
 * 100%-to-78% regime change this project itself lived through); it is
 * unsafe when it is HIGHER (it reflects a regime that no longer applies).
 * Taking the minimum costs nothing in the safe direction — one wasted
 * summary if the project's regime actually did move up — and prevents the
 * unsafe direction, where a stale-high measurement suppresses the handover
 * past the real boundary. That asymmetry is the same one the 80-not-100
 * default was chosen for.
 *
 * Margins below effectiveTrigger are clamped at 0 (and logged) for a window
 * small enough that a margin would otherwise go negative — a pathological
 * input should degrade to "fire immediately", never to a threshold below
 * zero.
 */
export function contextFillThresholds(
  reading: ContextFillReading,
  env: NodeJS.ProcessEnv = process.env,
  opts: ContextFillThresholdOpts = {}
): ContextFillThresholds {
  const windowConfirmed = reading.source === "statusline";
  const autocompactPct = resolveAutocompactPct(env);
  const configuredTriggerTokens = Math.round(reading.windowSize * (autocompactPct / 100));

  const measuredTriggerTokens = opts.measuredTrigger !== undefined
    ? opts.measuredTrigger
    : opts.cwd
      ? measureCompactionTrigger(opts.cwd)
      : null;

  let effectiveTriggerTokens: number;
  let triggerSource: TriggerSource;

  if (measuredTriggerTokens === null) {
    effectiveTriggerTokens = configuredTriggerTokens;
    triggerSource = "configured";
    console.error(
      `[context-fill] trigger source: CONFIGURED — no compaction history for this project yet. ` +
      `measured=none, configured=${configuredTriggerTokens} (${autocompactPct}% of a ${reading.windowSize}-token ` +
      `window) -> using ${effectiveTriggerTokens}.`
    );
  } else if (measuredTriggerTokens <= configuredTriggerTokens) {
    effectiveTriggerTokens = measuredTriggerTokens;
    triggerSource = "measured";
    console.error(
      `[context-fill] trigger source: MEASURED — measured=${measuredTriggerTokens} ` +
      `(minimum of the most recent ${MEASURED_TRIGGER_SAMPLE_SIZE} compact_boundary events), ` +
      `configured=${configuredTriggerTokens} -> using ${effectiveTriggerTokens} (measured, ≤ configured).`
    );
  } else {
    effectiveTriggerTokens = configuredTriggerTokens;
    triggerSource = "measured-clamped";
    console.error(
      `[context-fill] trigger source: MEASURED-CLAMPED — measured=${measuredTriggerTokens} is HIGHER than ` +
      `configured=${configuredTriggerTokens} (a stale regime this project's history predates) -> ` +
      `using ${effectiveTriggerTokens} (configured, the safer bound).`
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
    measuredTriggerTokens,
    configuredTriggerTokens,
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
