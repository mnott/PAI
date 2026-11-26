/**
 * session-summary-worker.ts — AI-powered session note generation
 *
 * Processes `session-summary` work items by:
 *   1. Finding the current session's JSONL transcript
 *   2. Extracting user messages and assistant context
 *   3. Gathering git commits from the session period
 *   4. Spawning Claude (sonnet for compaction, opus for session end) to generate a structured summary
 *   5. Comparing the new topic against the existing note's topic
 *   6. Creating a NEW note if the topic shifted, or updating the existing one
 *
 * Topic detection: the summarizer outputs a TOPIC: line as the first line of
 * its response. This is compared against the existing note's title using word
 * overlap. If overlap is below ~30%, a new note is created.
 *
 * Designed to run inside the daemon's work queue worker. All errors are
 * thrown (not swallowed) so the work queue retry logic handles them.
 */

import { deferIfQuiet } from "./quiet.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

import {
  findNotesDir,
  getCurrentNotePath,
  createSessionNote,
  addWorkToSessionNote,
  renameSessionNote,
} from "../hooks/ts/lib/project-utils/index.js";

import { buildSessionSummaryPrompt } from "./templates/session-summary-prompt.js";
import { redactSecrets } from "../utils/redact.js";
import {
  extractAndStoreTriples as kgExtractAndStoreTriples,
} from "../memory/kg-extraction.js";
import { getRegistryBackend } from "../storage/factory.js";
import { drainRenameQueue } from "../storage/session-note-registry.js";
import { storageBackend, daemonConfig } from "./daemon/state.js";
import { recordSystemJobStart } from "../workers/pane-waiver.js";
import { planSummarySpawn, DAEMON_LLM_ENV_MARKER, type ModelTier } from "../workers/daemon-llm.js";
import { helperComplete } from "../workers/helper.js";
import { claudeProjectsDir, legacyConfigDir, paiHomePath, resolvePaiFile, migratePaiFile, type MigrateFileResult } from "../config/pai-home.js";
import { findClaudeBinary } from "../memory/kg-extraction.js";
import { addNoteSession } from "../session/note-sessions.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval between summaries for the same project (ms). */
const SUMMARY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** Default: new user/assistant text (chars) since the last note write that triggers a summary on any Stop. */
const MIN_NEW_TEXT_CHARS = 6_000;
/** Default: minutes since the last note write after which a Stop with a little new text triggers a summary. */
const DEFAULT_INTERVAL_MINUTES = 10;
/** A first summary of a session with one user message needs at least this much conversation text. */
const MIN_SINGLE_MESSAGE_CHARS = 500;
/** The time trigger needs at least this much new text (a Stop with nothing new writes nothing). */
const MIN_TIME_TRIGGER_CHARS = 200;
/** Hard cap on the whole prompt; the newest content is kept. */
const MAX_PROMPT_CHARS = 120_000;
const MAX_EXISTING_NOTE_CHARS = 40_000;
const MAX_GIT_CHARS = 20_000;

/** A Stop the debounce skips probes the topic once this much new text arrived since the last check. */
const TOPIC_PROBE_MIN_CHARS = 8_000;
/** At most one probe per session per this interval. */
const TOPIC_PROBE_INTERVAL_MS = 5 * 60 * 1000;
/** The probe sees only the newest part, capped. */
const TOPIC_PROBE_CHARS = 6_000;

/** Per-session summary state: when it last ran and how far into the transcript. */
export interface SessionSummaryState {
  at: number;
  offset: number;
  /** The note this session last wrote (follows the session across notes and projects). */
  note?: string;
}

function sessionStateFile(): string {
  return paiHomePath("summary-sessions.json");
}

function loadSessionStates(): Record<string, SessionSummaryState> {
  try {
    const f = sessionStateFile();
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf-8"));
  } catch { /* ignore */ }
  return {};
}

function saveSessionState(key: string, st: SessionSummaryState): void {
  try {
    const all = loadSessionStates();
    all[key] = st;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(all)) if (all[k].at < cutoff) delete all[k];
    mkdirSync(dirname(sessionStateFile()), { recursive: true });
    writeFileSync(sessionStateFile(), JSON.stringify(all), "utf-8");
  } catch { /* ignore */ }
}

/**
 * Decide whether a session needs a new summary. A final run (real session end)
 * always summarizes. Otherwise, on a Stop between compacts:
 *   - at least `minChars` (default 6000) of new conversation text since the last
 *     summary, or
 *   - at least `intervalMs` (default 10 min) since the last note write and a
 *     little new text (`timeMinChars`).
 * `newTextChars` is evaluated lazily because it reads the transcript tail.
 */
export function shouldSummarize(
  state: SessionSummaryState | undefined,
  opts: {
    final?: boolean; force?: boolean; intervalMs: number; now?: number; newTextChars: () => number;
    minChars?: number; timeMinChars?: number;
  },
): { run: boolean; reason: string } {
  if (opts.final) return { run: true, reason: "final" };
  if (opts.force) return { run: true, reason: "forced" };
  if (!state) return { run: true, reason: "first" };
  const age = (opts.now ?? Date.now()) - state.at;
  const n = opts.newTextChars();
  if (n >= (opts.minChars ?? MIN_NEW_TEXT_CHARS)) return { run: true, reason: `${n} new chars` };
  if (age >= opts.intervalMs && n >= (opts.timeMinChars ?? MIN_TIME_TRIGGER_CHARS)) {
    return { run: true, reason: `${n} new chars, ${Math.round(age / 60_000)} min since last note write` };
  }
  return { run: false, reason: `only ${n} new chars, last summary ${Math.round(age / 1000)}s ago` };
}

/** Keep the newest `max` chars. */
export function capPrompt(prompt: string, max = MAX_PROMPT_CHARS): string {
  return prompt.length <= max ? prompt : prompt.slice(prompt.length - max);
}

/** Safety cap on the transcript range scanned in one run (the newest part wins). */
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Stream the complete lines of bytes [from, size) of a file to `onLine`.
 * The whole range is scanned, not a raw-byte tail: a transcript is mostly tool
 * results, so the last N bytes of a long session hold almost no user/assistant
 * text and used to make "new chars" read ~1 KB after hours of work.
 * Returns the offset to resume from: the end of the last complete line, or the
 * file size when the trailing unterminated line is complete JSON.
 */
function scanLines(path: string, from: number, onLine: (line: string) => void): number {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let start = Math.max(0, Math.min(from, size));
    let skipFirst = false;
    if (size - start > MAX_SCAN_BYTES) { start = size - MAX_SCAN_BYTES; skipFirst = true; }
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(SCAN_CHUNK_BYTES, size - start)));
    let pos = start;
    let carry: Buffer = Buffer.alloc(0);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let lineStart = 0;
      for (;;) {
        const nl = data.indexOf(10, lineStart);
        if (nl < 0) break;
        if (skipFirst) skipFirst = false;
        else onLine(data.toString("utf-8", lineStart, nl));
        lineStart = nl + 1;
      }
      carry = data.subarray(lineStart);
    }
    if (carry.length && !skipFirst) {
      const tail = carry.toString("utf-8");
      try { JSON.parse(tail); onLine(tail); return size; } catch { return size - carry.length; }
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

/**
 * Text the user or assistant wrote: string content and `text` blocks only.
 * tool_result / tool_use / thinking blocks are tool output (fetched pages, file
 * dumps), never the session's own words, so they neither count as new text nor
 * reach the summarizer prompt (a fetched page <title> used to become the note title).
 */
export function conversationText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      const block = c as Record<string, unknown>;
      return block?.type === "text" && block.text ? String(block.text) : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Maximum user messages to include in the prompt. */
const MAX_USER_MESSAGES = 30;

/** File tracking last summary timestamps per project — resolved under
 *  PAI_HOME, falling back to the pre-2026-09-19 ~/.config/pai location. */
function oldCooldownFile(): string {
  return join(legacyConfigDir(), "summary-cooldowns.json");
}

function cooldownFilePath(): string {
  return resolvePaiFile(paiHomePath("summary-cooldowns.json"), [oldCooldownFile()], "pai config migrate");
}

export function migrateSummaryCooldowns(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("summary-cooldowns.json"), [oldCooldownFile()], opts);
}

/** Claude Code projects directory. */
const CLAUDE_PROJECTS_DIR = () => claudeProjectsDir();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummaryPayload {
  cwd: string;
  sessionId?: string;
  projectSlug?: string;
  transcriptPath?: string;
  /** Real session end: summarize once now regardless of the debounce. */
  final?: boolean;
  /** If true, bypass the cooldown check (e.g. triggered by stop-hook at session end). */
  force?: boolean;
  /** Model tier to use for summarization (resolved to the configured
   *  provider's model id). Defaults based on trigger:
   *  - forced (mid-session auto-save, every N messages): "haiku" — runs often
   *  - everything else (manual, reconstruct, batch): "sonnet"
   *  Session end does not summarise via an LLM at all; it is mechanical. */
  model?: ModelTier;
}

// ---------------------------------------------------------------------------
// Cooldown tracking
// ---------------------------------------------------------------------------

function loadCooldowns(): Record<string, number> {
  try {
    const file = cooldownFilePath();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveCooldowns(cooldowns: Record<string, number>): void {
  try {
    const file = paiHomePath("summary-cooldowns.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cooldowns, null, 2), "utf-8");
  } catch { /* ignore */ }
}

function isOnCooldown(cwd: string): boolean {
  const cooldowns = loadCooldowns();
  const lastRun = cooldowns[cwd];
  if (!lastRun) return false;
  return Date.now() - lastRun < SUMMARY_COOLDOWN_MS;
}

function markCooldown(cwd: string): void {
  const cooldowns = loadCooldowns();
  cooldowns[cwd] = Date.now();
  // Prune entries older than 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const key of Object.keys(cooldowns)) {
    if (cooldowns[key] < cutoff) delete cooldowns[key];
  }
  saveCooldowns(cooldowns);
}

// ---------------------------------------------------------------------------
// JSONL discovery
// ---------------------------------------------------------------------------

/**
 * Encode a cwd path the same way Claude Code does for its project directories.
 * Replaces /, space, dot, and hyphen with -.
 */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[\/\s.\-]/g, "-");
}

/**
 * Find the most recently modified JSONL file for the given project.
 *
 * Claude Code stores transcripts in:
 *   ~/.claude/projects/<encoded-path>/sessions/*.jsonl
 *   ~/.claude/projects/<encoded-path>/<uuid>.jsonl (legacy)
 */
export function findLatestJsonl(cwd: string): string | null {
  const encoded = encodeProjectPath(cwd);
  const projectDir = join(CLAUDE_PROJECTS_DIR(), encoded);

  if (!existsSync(projectDir)) {
    process.stderr.write(
      `[session-summary] No Claude project dir found: ${projectDir}\n`
    );
    return null;
  }

  // Collect all JSONL candidates
  const candidates: Array<{ path: string; mtime: number }> = [];

  // Check sessions/ subdirectory first (current layout)
  const sessionsDir = join(projectDir, "sessions");
  if (existsSync(sessionsDir)) {
    try {
      for (const f of readdirSync(sessionsDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fullPath = join(sessionsDir, f);
        try {
          const st = statSync(fullPath);
          candidates.push({ path: fullPath, mtime: st.mtimeMs });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Also check top-level for legacy .jsonl files
  try {
    for (const f of readdirSync(projectDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const fullPath = join(projectDir, f);
      try {
        const st = statSync(fullPath);
        candidates.push({ path: fullPath, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (candidates.length === 0) {
    process.stderr.write(
      `[session-summary] No JSONL files found in ${projectDir}\n`
    );
    return null;
  }

  // Sort by modification time descending — pick the most recent
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

// ---------------------------------------------------------------------------
// JSONL content extraction
// ---------------------------------------------------------------------------

export interface ExtractedContent {
  textChars: number;
  endOffset: number;
  userMessages: string[];
  filesModified: string[];
  sessionStartTime: string;
  /** Working directories the extracted entries ran in, in order of first appearance. */
  cwds: string[];
  /** Newest user/assistant text of the extracted part (tail, capped at TOPIC_PROBE_CHARS). */
  recentText: string;
}

/**
 * Parse a JSONL transcript and extract relevant content.
 * Filters noise, truncates to model-appropriate size from the end of the file.
 */
export function extractFromJsonl(jsonlPath: string, _tier: ModelTier = "sonnet", fromOffset = 0): ExtractedContent {
  const result: ExtractedContent = {
    userMessages: [],
    filesModified: [],
    sessionStartTime: "",
    cwds: [],
    textChars: 0,
    endOffset: 0,
    recentText: "",
  };

  const seenMessages = new Set<string>();

  const handle = (line: string): void => {
    if (!line.trim()) return;
    // tool results dominate the transcript; skip their (huge) lines unparsed
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"timestamp"')) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }

    if (entry.timestamp && !result.sessionStartTime) {
      result.sessionStartTime = String(entry.timestamp);
    }

    if (typeof entry.cwd === "string" && entry.cwd && !result.cwds.includes(entry.cwd)) result.cwds.push(entry.cwd);

    if (entry.type !== "user" && entry.type !== "assistant") return;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg?.content) return;
    const t = conversationText(msg.content);
    if (t && !isNoise(t)) {
      result.textChars += t.length;
      result.recentText = (result.recentText + "\n" + t).slice(-TOPIC_PROBE_CHARS);
      if (entry.type === "user" && !seenMessages.has(t)) {
        seenMessages.add(t);
        result.userMessages.push(t.slice(0, 500));
        if (result.userMessages.length > MAX_USER_MESSAGES * 4) result.userMessages = result.userMessages.slice(-MAX_USER_MESSAGES);
      }
    }

    // file modifications from assistant tool_use blocks
    if (entry.type === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_use") continue;
        const input = block.input as Record<string, unknown> | undefined;
        if ((block.name === "Edit" || block.name === "Write") && input?.file_path) {
          const fp = String(input.file_path);
          if (!result.filesModified.includes(fp)) result.filesModified.push(fp);
        }
      }
    }
  };

  try {
    result.endOffset = scanLines(jsonlPath, fromOffset, handle);
  } catch (e) {
    throw new Error(`Could not read JSONL at ${jsonlPath}: ${e}`);
  }

  // Limit user messages
  if (result.userMessages.length > MAX_USER_MESSAGES) {
    result.userMessages = result.userMessages.slice(-MAX_USER_MESSAGES);
  }

  return result;
}

/** Filter out noise entries that shouldn't be included in the summary. */
function isNoise(text: string): boolean {
  if (!text || text.length < 3) return true;
  if (text.includes("<task-notification>")) return true;
  if (text.includes("[object Object]")) return true;
  if (text.startsWith("<system-reminder>")) return true;
  if (/^(yes|ok|sure|go|continue|weiter|thanks|thank you)\.?$/i.test(text.trim())) return true;
  // Skip pure tool result blocks
  if (text.startsWith("Tool Result:") || text.startsWith("tool_result")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Git context
// ---------------------------------------------------------------------------

/**
 * Get git log for the session period.
 * Falls back gracefully if git is not available or the dir is not a repo.
 */
export async function getGitContext(cwd: string, sinceTime?: string): Promise<string> {
  let since = "6 hours ago";
  if (sinceTime) {
    // sinceTime may be a Unix epoch (seconds as string) or already ISO 8601
    const asNum = Number(sinceTime);
    if (!isNaN(asNum) && asNum > 1_000_000_000) {
      // Unix epoch seconds → ISO 8601 (git accepts this unambiguously)
      since = new Date(asNum * 1000).toISOString();
    } else {
      since = sinceTime;
    }
  }

  try {
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);

    const { stdout } = await execFileAsync(
      "git",
      ["log", "--format=%h %ai %s", `--since=${since}`, "--stat", "--no-color"],
      {
        cwd,
        timeout: 10_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Claude CLI spawning
// ---------------------------------------------------------------------------

/** `sessionSummary.model` of the PAI config (default `local`). */
function configuredSummaryModel(): string | undefined {
  const m = (daemonConfig as { sessionSummary?: { model?: unknown } } | undefined)?.sessionSummary?.model;
  return typeof m === "string" && m.trim() ? m.trim() : undefined;
}

/**
 * Spawn a Claude model via the CLI to generate a session summary.
 * Pipes the prompt via stdin. Tier selection (resolved to the configured
 * provider's model id, falling back to the tier alias when no provider is
 * configured — see planLlmSpawn):
 *   - opus: session end (best quality for final summary, runs once)
 *   - sonnet: auto-compaction (good quality for incremental checkpoints, runs often)
 *   - haiku: fallback / budget mode
 * Returns the generated text, or null if spawning fails.
 */
type SummarizerFn = (prompt: string, tier: ModelTier, modelSpec?: string) => Promise<string | null>;
let summarizerOverride: SummarizerFn | null = null;

/** Test seam: replace the summary model call (null restores the real one). */
export function setSummarizerForTests(fn: SummarizerFn | null): void {
  summarizerOverride = fn;
}

export async function spawnSummarizer(prompt: string, tier: ModelTier = "sonnet", modelSpec?: string): Promise<string | null> {
  const claudeBin = findClaudeBinary();
  if (!claudeBin) {
    process.stderr.write(
      "[session-summary] Claude CLI not found in PATH or common locations.\n"
    );
    return null;
  }

  let plan;
  try {
    plan = await planSummarySpawn(modelSpec ?? configuredSummaryModel(), tier);
  } catch (e) {
    process.stderr.write(`[session-summary] could not plan ${tier} spawn: ${e}\n`);
    return null;
  }

  process.stderr.write(
    `[session-summary] model=${plan.model} via ${plan.provider ?? "cloud"} chars=${prompt.length}\n`
  );

  const { spawn } = await import("node:child_process");
  recordSystemJobStart("session-summary");

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(claudeBin, plan.args, {
      env: plan.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      if (timer) { clearTimeout(timer); timer = null; }
      process.stderr.write(`[session-summary] ${plan.model} spawn error: ${err.message}\n`);
      resolve(null);
    });

    child.on("close", (code: number | null) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (code !== 0) {
        process.stderr.write(
          `[session-summary] ${plan.model} exited with code ${code}: ${stderr.slice(0, 300)}\n`
        );
        resolve(null);
      } else {
        resolve(stdout.trim() || null);
      }
    });

    // Timeout protection
    timer = setTimeout(() => {
      process.stderr.write(`[session-summary] ${plan.model} timed out — killing process.\n`);
      child.kill("SIGTERM");
      resolve(null);
    }, plan.timeoutMs);

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Topic extraction and comparison
// ---------------------------------------------------------------------------

/**
 * Extract the TOPIC: line from the summarizer output.
 * Returns the topic string, or null if not found.
 */
/**
 * Title to rename a note to after a summary: the summary's "# Session:" title,
 * or, for a note still named "New Session", its TOPIC line. Null: keep the name.
 */
export function noteRenameTitle(notePath: string, summaryText: string): string | null {
  const heading = summaryText.match(/^# Session:\s*(.+)$/m)?.[1]
    ?? (/ - New Session\.md$/.test(basename(notePath)) ? extractTopic(summaryText) : null);
  return heading ? heading.trim() : null;
}

function extractTopic(summaryText: string): string | null {
  const match = summaryText.match(/^TOPIC:\s*(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Extract the topic from an existing session note.
 * First checks for a <!-- TOPIC: ... --> comment (stored by previous summaries).
 * Falls back to the H1 "# Session NNNN: Title" line.
 *
 * The HTML comment is the reliable source because the H1 gets renamed by
 * renameSessionNote, which can add/change words and cause false topic shifts.
 */
function extractExistingNoteTitle(notePath: string): string | null {
  try {
    const content = readFileSync(notePath, "utf-8");
    // Prefer stored TOPIC comment (exact match to what the summarizer produced)
    const topicComment = content.match(/<!-- TOPIC:\s*(.+?)\s*-->/);
    if (topicComment) return topicComment[1].trim();
    // Fallback to H1
    const match = content.match(/^# Session \d+:\s*(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ignore */ }
  return null;
}

/**
 * Compute word overlap ratio between two topic strings.
 * Returns a value in [0, 1] — 1.0 means identical word sets.
 *
 * Uses lowercased, normalized words. Stop words and very short words
 * are excluded to avoid false positives on common terms.
 */
export function computeTopicOverlap(topicA: string, topicB: string): number {
  const stopWords = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "this", "that",
    "these", "those", "it", "its", "new", "session", "work", "done",
  ]);

  const normalize = (text: string): Set<string> => {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
    return new Set(words);
  };

  const wordsA = normalize(topicA);
  const wordsB = normalize(topicB);

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  // Jaccard similarity
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/** Threshold: below this overlap ratio, we consider topics different. */
// Raised from 0.3 to 0.15 — lower threshold means topics must be MORE different
// to trigger a split. 0.3 was too aggressive: incremental work on the same project
// (e.g., "Flutter Rewrite" vs "Fix Transcription in Flutter") was splitting into
// separate notes on every compaction.
export const TOPIC_OVERLAP_THRESHOLD = 0.15;

// ---------------------------------------------------------------------------
// Topic probe between debounced summaries
// ---------------------------------------------------------------------------

const probeState = new Map<string, { at: number; offset: number }>();

/** Test hook: forget the per-session probe state. */
export function resetTopicProbeState(): void {
  probeState.clear();
}

export interface TopicProbeResult { probed: boolean; shifted: boolean; reason: string; topic?: string }

/**
 * A Stop the debounce would skip: when at least TOPIC_PROBE_MIN_CHARS of new
 * text arrived since the last topic check, ask the helper chain for a 3-8 word
 * topic of the newest part and compare it with the note's current topic.
 * One probe per session per 5 minutes; helper chain down -> the summary model; neither -> no probe, no error.
 */
export async function probeTopicShift(o: {
  key: string;
  jsonlPath: string;
  fromOffset: number;
  currentTopic: string | null;
  now?: number;
  helper?: typeof helperComplete;
  /** No helper answered: the same small prompt on the summary model (default: spawnSummarizer, haiku tier). */
  fallback?: (prompt: string) => Promise<string | null>;
}): Promise<TopicProbeResult> {
  const now = o.now ?? Date.now();
  const prev = probeState.get(o.key);
  if (prev && now - prev.at < TOPIC_PROBE_INTERVAL_MS) return { probed: false, shifted: false, reason: "probe rate limit" };
  if (!o.currentTopic) return { probed: false, shifted: false, reason: "no current topic" };
  const from = Math.max(o.fromOffset, prev?.offset ?? 0);
  let ex: ExtractedContent;
  try {
    ex = extractFromJsonl(o.jsonlPath, "haiku", from);
  } catch {
    return { probed: false, shifted: false, reason: "transcript unreadable" };
  }
  if (ex.textChars < TOPIC_PROBE_MIN_CHARS) return { probed: false, shifted: false, reason: `only ${ex.textChars} new chars` };
  probeState.set(o.key, { at: now, offset: prev?.offset ?? 0 });
  const task = "State the topic of this AI-coding-session excerpt in 3 to 8 words. Reply with the topic alone, nothing else.";
  const input = redactSecrets(ex.recentText);
  let answer: string | null = null;
  try {
    answer = await (o.helper ?? helperComplete)({ label: "topic-shift", maxTokens: 24, timeoutMs: 15_000, keep: "tail", task, input });
  } catch {
    answer = null;
  }
  if (!answer?.trim()) {
    // the helper chain is empty or down (no apple-fm on Linux): the summary model answers the same prompt
    try {
      answer = await (o.fallback ?? ((p) => (summarizerOverride ?? spawnSummarizer)(p, "haiku")))(`${task}\n\n${input}`);
    } catch {
      answer = null;
    }
  }
  const topic = answer?.split("\n")[0].replace(/^\s*topic\s*[:\-]\s*/i, "").replace(/^["'*\s]+|["'*.\s]+$/g, "").slice(0, 120) ?? "";
  if (!topic || !/[a-z0-9]{3,}/i.test(topic)) return { probed: false, shifted: false, reason: "no model answered" };
  probeState.set(o.key, { at: now, offset: ex.endOffset });
  const overlap = computeTopicOverlap(topic, o.currentTopic);
  return overlap < TOPIC_OVERLAP_THRESHOLD
    ? { probed: true, shifted: true, topic, reason: `topic shift "${topic}" vs "${o.currentTopic}" (overlap ${overlap.toFixed(2)})` }
    : { probed: true, shifted: false, topic, reason: `same topic "${topic}" (overlap ${overlap.toFixed(2)})` };
}

// ---------------------------------------------------------------------------
// Session note writing
// ---------------------------------------------------------------------------

/** Topic of the session's current note (today's), or null. */
function currentNoteTopic(cwd: string, sessionId?: string): string | null {
  try {
    const dir = findNotesDir(cwd).path;
    const p = sessionId ? findNoteBySessionId(dir, sessionId) : getCurrentNotePath(dir);
    return p ? extractExistingNoteTitle(p) : null;
  } catch {
    return null;
  }
}

/**
 * Write (or update) the session note with the AI-generated summary.
 *
 * Strategy:
 *   - Find the current month's latest note
 *   - If it's from today, compare topics:
 *     - Same topic (overlap >= 30%) → update existing note
 *     - Different topic (overlap < 30%) → create a NEW note
 *   - If it's from a different day, create a new note
 */
/**
 * Return true if the summarizer output has a meaningful body — i.e. content
 * beyond the TOPIC:/title/metadata/horizontal-rule scaffolding.
 *
 * A summary that is only headers (no Work Done items) must NOT create or update
 * a note: doing so births an empty-bodied scaffold that later rename/finalize
 * can strip to a footer-only stub. This is the born-stub failure mode.
 */
function summaryHasContent(summaryText: string): boolean {
  const body = summaryText
    .replace(/^TOPIC:.*$/m, "")
    .replace(/^# Session:.*$/m, "")
    .replace(/^\*\*(Date|Status|Completed):\*\*.*$/gm, "")
    .replace(/^#{1,6}\s.*$/gm, "")   // bare section headers (## Work Done, etc.)
    .replace(/^---$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "") // template placeholder comments
    .trim();
  return body.length > 0;
}

function writeSessionNote(
  cwd: string,
  summaryText: string,
  filesModified: string[],
  sessionId?: string,
  previousNote?: string,
  userMessages: string[] = [],
): string | null {
  // Never create/update a note from a body-less summary — that is the born-stub
  // path (empty scaffold → stripped to a footer-only stub on finalize/rename).
  if (!summaryHasContent(summaryText)) {
    process.stderr.write(
      `[session-summary] Summary has no meaningful body — skipping note write.\n`
    );
    return null;
  }

  const notesInfo = findNotesDir(cwd);
  const today = new Date().toISOString().split("T")[0];
  const newTopic = extractTopic(summaryText);

  // Identity first: the note this session already owns. With a session id the
  // positional lookup (numerically highest note) is never used: it is a position,
  // not an identity, and handed one session another session's note.
  const owned = sessionId ? findNoteBySessionId(notesInfo.path, sessionId) : null;
  let notePath: string | null = owned ?? (sessionId ? null : getCurrentNotePath(notesInfo.path));

  /** The note this session wrote before the one written now: closed and linked to it. */
  let closeAfter: string | null = null;
  /** True when the note was created or adopted now: it gets its conversation title (file name). */
  let fresh = false;

  if (notePath) {
    const noteDate = basename(notePath).match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    if (noteDate === today) {
      // Check for topic shift — two signals:
      // 1. TOPIC: line from summarizer vs existing note title (word overlap)
      // 2. topic-boundary.json written by topic-detect-worker (project-level shift)
      const existingTitle = extractExistingNoteTitle(notePath);
      let topicShifted = false;

      if (newTopic && existingTitle) {
        const overlap = computeTopicOverlap(newTopic, existingTitle);
        process.stderr.write(
          `[session-summary] Topic overlap: ${(overlap * 100).toFixed(1)}%` +
          ` (new="${newTopic}", existing="${existingTitle}")\n`
        );
        if (overlap < TOPIC_OVERLAP_THRESHOLD) {
          topicShifted = true;
          process.stderr.write(`[session-summary] Topic shift detected (word overlap) — creating new note.\n`);
        }
      }

      if (!topicShifted) {
        const boundaryPath = join(notesInfo.path, "topic-boundary.json");
        if (existsSync(boundaryPath)) {
          try {
            const boundary = JSON.parse(readFileSync(boundaryPath, "utf-8"));
            if (boundary.timestamp) {
              const boundaryAge = Date.now() - new Date(boundary.timestamp).getTime();
              // Only honor boundaries from the last 30 minutes
              if (boundaryAge < 30 * 60 * 1000) {
                topicShifted = true;
                process.stderr.write(
                  `[session-summary] Topic shift detected (boundary marker) — ` +
                  `${boundary.previousProject} → ${boundary.suggestedProject}\n`
                );
              }
            }
            unlinkSync(boundaryPath); // one-shot
          } catch { /* ignore invalid boundary file */ }
        }
      }

      if (topicShifted) {
        closeAfter = notePath;
        notePath = createNoteFromSummary(notesInfo.path, summaryText, sessionId, undefined, userMessages);
        fresh = true;
      } else {
        updateNoteWithSummary(notePath, summaryText);
        process.stderr.write(`[session-summary] Updated existing note: ${basename(notePath)}\n`);
      }
    } else {
      // Different day — create a new note
      closeAfter = notePath;
      notePath = createNoteFromSummary(notesInfo.path, summaryText, sessionId, undefined, userMessages);
      fresh = true;
    }
  } else {
    // The session owns no note here. The session-start hook left a stub for it:
    // fill that in place instead of creating a second file beside it.
    const stub = sessionId ? findUnclaimedStub(notesInfo.path) : null;
    notePath = createNoteFromSummary(notesInfo.path, summaryText, sessionId, stub ?? undefined, userMessages);
    fresh = true;
    // Work moved here from another note (cwd change): that note is closed and linked.
    if (previousNote && existsSync(previousNote) && previousNote !== notePath) closeAfter = previousNote;
  }

  // A new note gets its conversation title as file name. Later updates keep the
  // name: links between notes point at it.
  if (notePath && fresh) {
    const title = noteRenameTitle(notePath, summaryText);
    if (title && title.length > 5 && title.length < 80) {
      notePath = renameSessionNote(notePath, title);
    }
  }

  if (notePath && closeAfter && closeAfter !== notePath) linkNotes(closeAfter, notePath);

  return notePath;
}

const noteStem = (p: string): string => basename(p).replace(/\.md$/, "");

/**
 * Close `prev` (this session moved on to `next`) and link both ways:
 * prev gets Status Completed and "Continued in [[next]]", its session marker
 * becomes an ended marker (it no longer owns the session); next gets "Continues
 * from [[prev]]". Idempotent.
 */
export function linkNotes(prev: string, next: string): void {
  try {
    let p = readFileSync(prev, "utf-8");
    const nextLink = `[[${noteStem(next)}]]`;
    p = p.replace(/<!-- SESSION: (\S+) -->/g, "<!-- SESSION-ENDED: $1 -->");
    p = p.replace("**Status:** In Progress", "**Status:** Completed");
    if (!p.includes("**Completed:**")) p = p.replace(/^(\*\*Status:\*\* Completed)$/m, `$1\n**Completed:** ${new Date().toISOString()}`);
    if (!p.includes(nextLink)) p = p.replace(/^(\*\*Status:\*\*.*(?:\n\*\*Completed:\*\*.*)?)$/m, `$1\n**Continued in:** ${nextLink}`);
    if (!p.includes(nextLink)) p += `\n**Continued in:** ${nextLink}\n`;
    writeFileSync(prev, p, "utf-8");

    let n = readFileSync(next, "utf-8");
    const prevLink = `[[${noteStem(prev)}]]`;
    if (!n.includes(prevLink)) {
      n = /^\*\*Status:\*\*.*$/m.test(n)
        ? n.replace(/^(\*\*Status:\*\*.*)$/m, `$1\n**Continues from:** ${prevLink}`)
        : n + `\n**Continues from:** ${prevLink}\n`;
      writeFileSync(next, n, "utf-8");
    }
  } catch (e) {
    process.stderr.write(`[session-summary] Could not link ${basename(prev)} → ${basename(next)}: ${e}\n`);
  }
}

/** Delete the newest unclaimed stub of `cwd`'s notes dir when it is still the untouched template. */
function removePristineStub(cwd: string): void {
  try {
    const dir = findNotesDir(cwd).path;
    const stub = findUnclaimedStub(dir);
    if (!stub) return;
    const text = readFileSync(stub, "utf-8");
    if (!text.includes("<!-- PAI will add completed work here during session -->")) return;
    unlinkSync(stub);
    process.stderr.write(`[session-summary] Removed unused stub ${basename(stub)} (session moved to another project).\n`);
  } catch { /* best effort */ }
}

/** Month directories searched for a session's note: this month and the previous one. */
function noteMonthDirs(notesDir: string): string[] {
  const now = new Date();
  return [0, -1].map((delta) => {
    const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
    return join(notesDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"));
  });
}

/**
 * The session-start stub nobody has claimed: a "New Session" note without a
 * session marker. The newest one wins.
 */
function findUnclaimedStub(notesDir: string): string | null {
  let best: { path: string; num: number } | null = null;
  for (const dir of noteMonthDirs(notesDir)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d{3,4}) - .* - New Session\.md$/);
      if (!m) continue;
      const p = join(dir, f);
      try {
        if (/<!-- SESSION(-ENDED)?: /.test(readFileSync(p, "utf-8"))) continue;
      } catch { continue; }
      const num = Number(m[1]);
      if (!best || num > best.num) best = { path: p, num };
    }
  }
  return best?.path ?? null;
}

/**
 * Update an existing session note's Work Done section with AI-generated content.
 */
function updateNoteWithSummary(notePath: string, summaryText: string): void {
  if (!existsSync(notePath)) return;

  let content = readFileSync(notePath, "utf-8");

  // Update the TOPIC comment if present (keeps topic comparison stable across renames)
  const newTopic = extractTopic(summaryText);
  if (newTopic) {
    if (content.includes("<!-- TOPIC:")) {
      content = content.replace(/<!-- TOPIC:.*?-->/, `<!-- TOPIC: ${newTopic} -->`);
    } else {
      // Insert after H1 line
      content = content.replace(/^(# Session .+)$/m, `$1\n<!-- TOPIC: ${newTopic} -->`);
    }
  }

  // Extract the work items from the AI summary
  const workDoneMatch = summaryText.match(
    /## Work Done\n\n([\s\S]*?)(?=\n## Key Decisions|\n## Known Issues|\n\*\*Tags|\n$)/
  );

  if (workDoneMatch) {
    const aiWorkContent = workDoneMatch[1].trim();
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];

    // Add as a new subsection under Work Done
    const sectionHeader = `\n### AI Summary (${timestamp})\n\n${aiWorkContent}\n`;

    const nextStepsIdx = content.indexOf("## Next Steps");
    const knownIssuesIdx = content.indexOf("## Known Issues");
    const insertBefore = knownIssuesIdx !== -1 ? knownIssuesIdx :
                          nextStepsIdx !== -1 ? nextStepsIdx :
                          content.length;

    content = content.slice(0, insertBefore) + sectionHeader + "\n" + content.slice(insertBefore);
  }

  // Extract and add Key Decisions if present
  const decisionsMatch = summaryText.match(
    /## Key Decisions\n\n([\s\S]*?)(?=\n## Known Issues|\n\*\*Tags|\n$)/
  );
  if (decisionsMatch) {
    const decisions = decisionsMatch[1].trim();
    if (decisions && !content.includes("## Key Decisions")) {
      const nextStepsIdx = content.indexOf("## Next Steps");
      const insertAt = nextStepsIdx !== -1 ? nextStepsIdx : content.length;
      content = content.slice(0, insertAt) + `## Key Decisions\n\n${decisions}\n\n` + content.slice(insertAt);
    }
  }

  // Extract and add Known Issues if present
  const issuesMatch = summaryText.match(
    /## Known Issues\n\n([\s\S]*?)(?=\n\*\*Tags|\n$)/
  );
  if (issuesMatch) {
    const issues = issuesMatch[1].trim();
    if (issues && !content.includes("## Known Issues")) {
      const nextStepsIdx = content.indexOf("## Next Steps");
      const insertAt = nextStepsIdx !== -1 ? nextStepsIdx : content.length;
      content = content.slice(0, insertAt) + `## Known Issues\n\n${issues}\n\n` + content.slice(insertAt);
    }
  }

  writeFileSync(notePath, redactSecrets(content), "utf-8");
}

/**
 * Create a brand new session note from the AI summary.
 */
/**
 * Find the note this session already owns, by the marker its first write left.
 *
 * The previous resolver, getCurrentNotePath, returned the numerically highest
 * note in the month directory. That is a position, not an identity, and it is
 * why one session produced many notes: whenever a session's own note was not
 * the current maximum — two sessions in one project, or a number collision, of
 * which one corpus had 110 — the lookup missed and the checkpoint created a
 * new file instead of updating. Measured consequence in that corpus: 303 of
 * 407 notes sat in 31 same-title groups, 48 of them sharing a single title.
 *
 * Matching on the session id makes the answer exact: a session either has a
 * note or it does not, regardless of what else the directory contains.
 */
function findNoteBySessionId(notesDir: string, sessionId: string): string | null {
  if (!sessionId || !existsSync(notesDir)) return null;
  const marker = `<!-- SESSION: ${sessionId} -->`;
  let best: { path: string; num: number } | null = null;
  for (const dir of noteMonthDirs(notesDir)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const p = join(dir, f);
      try {
        if (!readFileSync(p, "utf-8").includes(marker)) continue;
        const num = Number(f.match(/^(\d+)/)?.[1] ?? 0);
        if (!best || num > best.num) best = { path: p, num };
      } catch { /* unreadable file is not a match */ }
    }
  }
  return best?.path ?? null;
}

function createNoteFromSummary(
  notesDir: string,
  summaryText: string,
  sessionId?: string,
  /** An existing stub to fill in place instead of creating a new file. */
  stubPath?: string,
  userMessages: string[] = [],
): string | null {
  try {
    const notePath = stubPath ?? createSessionNote(notesDir, "New Session");

    // We will overwrite the entire content with the AI-generated summary, preserving
    // the note number (derived from the filename) and adding the standard footer.
    const noteFilename = basename(notePath);
    const numberMatch = noteFilename.match(/^(\d+)/);
    const noteNumber = numberMatch ? numberMatch[1] : "0000";

    // Replace the H1 title from the AI summary with the numbered format
    const titleMatch = summaryText.match(/^# Session:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : "New Session";

    const date = new Date().toISOString().split("T")[0];

    // Extract topic before stripping it (stored as HTML comment for future comparison)
    const topic = extractTopic(summaryText);

    // Build the final note content, merging AI output with the PAI note structure.
    // Strip the TOPIC: line (used for topic detection, not for the note body).
    const aiBody = summaryText
      .replace(/^TOPIC:.*$/m, "")
      .replace(/^# Session:.*$/m, "")
      .replace(/^\*\*Date:\*\*.*$/m, "")
      .replace(/^\*\*Status:\*\*.*$/m, "")
      .replace(/^---$/m, "")
      .trim();

    // The session marker is what later checkpoints of THIS session match on to
    // find and update this note rather than creating another one beside it.
    // What the user asked for: context a new note starts with, so it is not only the model's summary.
    const asked = userMessages.slice(-6).map((m) => `- ${m.replace(/\s+/g, " ").trim().slice(0, 200)}`);
    const requests = asked.length ? `\n## User Requests\n\n${asked.join("\n")}\n` : "";

    const finalContent = `# Session ${noteNumber}: ${title}
${topic ? `<!-- TOPIC: ${topic} -->` : ""}${sessionId ? `\n<!-- SESSION: ${sessionId} -->` : ""}

**Date:** ${date}
**Status:** In Progress

---

${aiBody}
${requests}
---

## Next Steps

<!-- To be filled at session end -->

---

**Tags:** #Session
`;

    writeFileSync(notePath, redactSecrets(finalContent), "utf-8");
    addNoteSession(notePath, sessionId);
    process.stderr.write(`[session-summary] Created AI-powered note: ${noteFilename}\n`);
    return notePath;
  } catch (e) {
    process.stderr.write(`[session-summary] Failed to create note: ${e}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// KG triple extraction
// ---------------------------------------------------------------------------

/**
 * Look up the integer project_id from the registry backend for a given slug.
 * Returns null if not found.
 */
async function lookupProjectId(slug: string): Promise<number | null> {
  try {
    const registry = await getRegistryBackend();
    const project = await registry.getProjectBySlug(slug);
    return project?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract structured KG triples from a session summary and store them.
 *
 * This is best-effort: any error is logged but never propagated.
 * Requires Postgres backend — silently no-ops on SQLite.
 */
async function extractAndStoreTriples(params: {
  summaryText: string;
  projectSlug: string;
  projectId: number | null;
  sessionId: string;
  gitLog: string;
  model: string;
}): Promise<void> {
  try {
    // Only works with Postgres backend — KG tables live in Postgres
    if (!storageBackend?.supportsPostgresFeatures) {
      return;
    }

    // Quiet mode: the summary itself still ran; the LLM extraction waits and
    // is caught up once from the notes (kg backfill) when quiet ends.
    if (deferIfQuiet("triple-extraction")) return;

    // Check config flag (default: true)
    const cfg = daemonConfig as (typeof daemonConfig & { kg_extraction_enabled?: boolean }) | undefined;
    if (cfg && cfg.kg_extraction_enabled === false) {
      process.stderr.write("[session-summary] Triple extraction disabled via kg_extraction_enabled=false.\n");
      return;
    }

    // storageBackend is already confirmed Postgres above — entity upserts
    // inside kgExtractAndStoreTriples go straight to Postgres, no SQLite touched.
    const result = await kgExtractAndStoreTriples(storageBackend, {
      summaryText: params.summaryText,
      projectSlug: params.projectSlug,
      projectId: params.projectId,
      sessionId: params.sessionId,
      gitLog: params.gitLog,
      model: "sonnet",
    });

    process.stderr.write(
      `[session-summary] Triple extraction complete: ` +
      `${result.extracted} extracted, ${result.added} added, ${result.superseded} superseded.\n`
    );
  } catch (err) {
    // Entire extraction is best-effort — never fail the session summary
    process.stderr.write(`[session-summary] Triple extraction failed: ${err}\n`);
  }
}

// ---------------------------------------------------------------------------
// Daemon-LLM transcript backstop
// ---------------------------------------------------------------------------

/**
 * True when a transcript belongs to a daemon-spawned LLM run (summarizer,
 * topic probe, KG extraction) rather than a real interactive session.
 *
 * Those runs spawn with cwd "/" and the `PAI_DAEMON_LLM=1` marker, and their
 * transcripts land under `~/.claude/projects/-/sessions/`. Summarizing one
 * spawns another summarizer — the feedback loop of 2026-11-24 (401 runs). The
 * hooks now skip enqueueing for such runs; this is the worker-side backstop for
 * jobs that arrive anyway (e.g. enqueued before the fix, or by a stale hook).
 *
 * `cwd === "/"` alone is not enough: a real session could in principle run at
 * the root. The transcript location is the reliable signal — the encoded
 * project dir for "/" is exactly "-".
 */
export function isDaemonLlmTranscript(jsonlPath: string, cwd: string): boolean {
  const underRootProject = jsonlPath.includes("/projects/-/");
  if (underRootProject) return true;
  // cwd "/" plus the marker is the daemon spawn's signature; the marker is
  // inherited by the hook process that enqueued the job.
  return cwd === "/" && process.env[DAEMON_LLM_ENV_MARKER] === "1";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<void>>();

/**
 * Process a `session-summary` work item. Runs for one session never overlap:
 * a second Stop of the same session waits for the first, then decides against
 * the cursor the first one saved (concurrent runs used to read the same offset
 * and write the same summary twice).
 */
export async function handleSessionSummary(payload: SessionSummaryPayload): Promise<void> {
  const key = payload.sessionId;
  if (!key) return handleSessionSummaryNow(payload);
  const prev = inFlight.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => handleSessionSummaryNow(payload));
  inFlight.set(key, run);
  try {
    await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

async function handleSessionSummaryNow(payload: SessionSummaryPayload): Promise<void> {
  const { cwd, sessionId, projectSlug, transcriptPath, force, final } = payload;

  if (!cwd) {
    throw new Error("session-summary payload missing cwd");
  }

  process.stderr.write(
    `[session-summary] Starting for ${cwd}` +
    `${sessionId ? ` (session=${sessionId})` : ""}` +
    `${force ? " (force=true)" : ""}\n`
  );

  // -------------------------------------------------------------------------
  // Cooldown check — don't summarize too frequently
  // force=true bypasses the cooldown (used by stop-hook at session end so a
  // final summary is always produced regardless of recent PreCompact runs).
  // -------------------------------------------------------------------------
  // The per-project cooldown is the legacy debounce for payloads without a session id;
  // a session is debounced by its own state (chars / minutes, see shouldSummarize).
  const onCooldown = !sessionId && !force && !final && isOnCooldown(cwd);

  // -------------------------------------------------------------------------
  // Step 1: Find the JSONL transcript
  // -------------------------------------------------------------------------
  let jsonlPath: string | null = transcriptPath || null;

  if (jsonlPath && !existsSync(jsonlPath)) {
    process.stderr.write(
      `[session-summary] Provided transcript path not found: ${jsonlPath}\n`
    );
    jsonlPath = null;
  }

  if (!jsonlPath) {
    jsonlPath = findLatestJsonl(cwd);
  }

  if (!jsonlPath) {
    process.stderr.write(
      "[session-summary] No JSONL transcript found — skipping.\n"
    );
    return;
  }

  process.stderr.write(`[session-summary] Using transcript: ${jsonlPath}\n`);

  // Backstop: never summarize a daemon-spawned LLM's own transcript — that is
  // the feedback loop (summarizer summarizes itself, forever).
  if (isDaemonLlmTranscript(jsonlPath, cwd)) {
    process.stderr.write(
      `[session-summary] Refusing daemon-LLM transcript ${jsonlPath} (cwd=${cwd}) — no summary.\n`
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Step 2: Extract content from the JSONL
  // -------------------------------------------------------------------------
  // Model selection: opus for session end (force=true), sonnet for auto-compact
  // `force` means "skip the cooldown" and nothing else. It used to also select
  // opus, on the assumption that a forced run was the one final session-end
  // summary. It is not: session end is handled mechanically by handleSessionEnd
  // and never reaches here. The only thing that sets force is the stop-hook's
  // mid-session auto-save, which fires every AUTO_SAVE_INTERVAL human messages
  // — so the most expensive model was running over a full transcript every 15
  // messages, in every open session. Measured: 102 opus vs 5 sonnet in 16h.
  //
  // Incremental checkpoints are a summarisation task with a clear input; haiku
  // is sufficient. Callers wanting better can still pass `model` explicitly.
  const selectedModel = payload.model ?? (force ? "haiku" : "sonnet");

  // Debounce + incremental: one summary per session per interval, only the
  // transcript part after the last summarized offset is read.
  const stateKey = sessionId ?? jsonlPath;
  const prevState = loadSessionStates()[stateKey];
  const cfgMin = (daemonConfig as { session_summary_interval_minutes?: number } | undefined)?.session_summary_interval_minutes;
  const intervalMs = (typeof cfgMin === "number" && cfgMin >= 0 ? cfgMin : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
  const cfgChars = (daemonConfig as { session_summary_min_chars?: number } | undefined)?.session_summary_min_chars;
  const minChars = typeof cfgChars === "number" && cfgChars >= 0 ? cfgChars : MIN_NEW_TEXT_CHARS;
  const fromOffset = prevState?.offset ?? 0;
  const gate = shouldSummarize(prevState, {
    final,
    // `force` (set by the Stop hook) only skips the legacy cooldown; it must not
    // bypass the chars/minutes gate, or every Stop would summarize.
    intervalMs,
    minChars,
    newTextChars: () => extractFromJsonl(jsonlPath!, selectedModel, fromOffset).textChars,
  });
  let runReason = gate.reason;
  // The session moved to another project: its work belongs in a note there now, so the
  // chars/minutes debounce must not leave the new project's session-start stub unclaimed.
  const movedCwd = !!prevState?.note && !!sessionId && existsSync(prevState.note)
    && !prevState.note.startsWith(findNotesDir(cwd).path + "/")
    && extractFromJsonl(jsonlPath!, selectedModel, fromOffset).textChars > 0;
  if (movedCwd) runReason = "cwd moved";
  if (!movedCwd && ((onCooldown && !force) || !gate.run)) {
    // the debounce would skip this Stop: a cheap topic probe may still call for a summary now
    const skipWhy = onCooldown ? "last summary was less than 30 minutes ago" : gate.reason;
    const probe = await probeTopicShift({
      key: stateKey,
      jsonlPath,
      fromOffset,
      currentTopic: currentNoteTopic(cwd, sessionId),
    });
    if (probe.reason !== "probe rate limit") process.stderr.write(`[session-summary] Topic probe ${stateKey}: ${probe.reason}.\n`);
    if (!probe.shifted) {
      process.stderr.write(`[session-summary] Skipping ${stateKey} — ${skipWhy}.\n`);
      return;
    }
    runReason = "topic shift";
  }
  const extracted = extractFromJsonl(jsonlPath, selectedModel, fromOffset);

  // A transcript with fewer than 2 real user messages is not a session worth
  // summarizing (a daemon LLM run, a one-shot probe, a stub). Summarizing one
  // spends a model slot for nothing.
  // An already-summarized session continues with whatever new messages arrive.
  // A first run with a single short message (a daemon LLM run, a one-shot probe) is not
  // worth a model slot; a single substantial exchange is real work and gets its note.
  if (extracted.userMessages.length < (prevState ? 1 : 2) && (prevState || extracted.textChars < MIN_SINGLE_MESSAGE_CHARS)) {
    process.stderr.write(
      `[session-summary] Fewer than 2 user messages (${extracted.userMessages.length}) in transcript — skipping.\n`
    );
    if (prevState) saveSessionState(stateKey, { ...prevState, at: Date.now(), offset: extracted.endOffset });
    return;
  }

  process.stderr.write(
    `[session-summary] Extracted ${extracted.userMessages.length} user messages, ` +
    `${extracted.filesModified.length} modified files.\n`
  );

  // -------------------------------------------------------------------------
  // Step 3: Get git context
  // -------------------------------------------------------------------------
  const gitLog = await getGitContext(cwd, extracted.sessionStartTime);

  if (gitLog) {
    process.stderr.write(
      `[session-summary] Got git context (${gitLog.split("\n").length} lines).\n`
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Build and send prompt to summarizer
  // -------------------------------------------------------------------------
  const today = new Date().toISOString().split("T")[0];

  // Check for existing note to merge with
  const notesInfo = findNotesDir(cwd);
  const existingNotePath = sessionId ? findNoteBySessionId(notesInfo.path, sessionId) : getCurrentNotePath(notesInfo.path);
  let existingNote: string | undefined;

  if (existingNotePath) {
    const noteFilename = basename(existingNotePath);
    const dateMatch = noteFilename.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch && dateMatch[1] === today) {
      try {
        existingNote = readFileSync(existingNotePath, "utf-8");
        // previous summary is the context for the increment; keep its newest part
        if (existingNote.length > MAX_EXISTING_NOTE_CHARS) existingNote = existingNote.slice(-MAX_EXISTING_NOTE_CHARS);
      } catch { /* ignore */ }
    }
  }

  // secret values never reach the summarizer prompt or the note it produces
  const prompt = capPrompt(redactSecrets(buildSessionSummaryPrompt({
    userMessages: extracted.userMessages,
    gitLog: gitLog.length > MAX_GIT_CHARS ? gitLog.slice(0, MAX_GIT_CHARS) : gitLog,
    cwd,
    date: today,
    filesModified: extracted.filesModified,
    existingNote,
  })));

  process.stderr.write(
    `[session-summary] Sending ${prompt.length} char prompt to ${selectedModel} ` +
    `(session=${stateKey} ${runReason} offset=${fromOffset}->${extracted.endOffset})...\n`
  );

  const summaryText = await (summarizerOverride ?? spawnSummarizer)(prompt, selectedModel, configuredSummaryModel());

  if (!summaryText) {
    process.stderr.write(
      `[session-summary] ${selectedModel} did not produce output — falling back to mechanical checkpoint.\n`
    );
    // Don't throw — this is a soft failure. The existing PreCompact checkpoint
    // is sufficient. Just mark the cooldown so we don't retry too soon.
    markCooldown(cwd);
    saveSessionState(stateKey, { ...prevState, at: Date.now(), offset: fromOffset });
    return;
  }

  process.stderr.write(
    `[session-summary] ${selectedModel} produced ${summaryText.length} char summary.\n`
  );

  // -------------------------------------------------------------------------
  // Step 5: Write the session note
  // -------------------------------------------------------------------------
  const notePath = writeSessionNote(cwd, summaryText, extracted.filesModified, sessionId, prevState?.note, extracted.userMessages);
  // The session moved here before it ever wrote a note: the empty stubs the
  // session-start hook left in the directories it passed through are junk.
  if (notePath && sessionId && !prevState) {
    for (const other of extracted.cwds) if (other !== cwd) removePristineStub(other);
  }

  if (notePath) {
    process.stderr.write(
      `[session-summary] Session note written: ${basename(notePath)}\n`
    );
  }

  // Registry rows follow the renames made above (and any queued by hooks).
  await drainRenameQueue(getRegistryBackend).catch(() => undefined);

  // -------------------------------------------------------------------------
  // Step 6: Best-effort KG triple extraction (Postgres only)
  // -------------------------------------------------------------------------
  const effectiveSlug = projectSlug ?? basename(cwd);
  const projectId = projectSlug ? await lookupProjectId(projectSlug) : null;

  await extractAndStoreTriples({
    summaryText,
    projectSlug: effectiveSlug,
    projectId,
    sessionId: sessionId ?? cwd,
    gitLog,
    model: selectedModel,
  });

  // Mark cooldown
  markCooldown(cwd);
  saveSessionState(stateKey, { at: Date.now(), offset: extracted.endOffset, note: notePath ?? prevState?.note });

  process.stderr.write("[session-summary] Done.\n");
}
