/**
 * session-keepalive.ts — idle-triggered prompt-cache keepalive beat for live
 * interactive Claude Code sessions (`sessions.cacheKeepalive`, see config.ts
 * and docs/cache-keepalive.md, "Interactive sessions").
 *
 * One beat = one trivial prompt typed into a session through AIBroker's
 * send_to_session (src/cli/lib/aibroker-client.ts), sent with `noReply: true`
 * so the target sees only the bare word typed into its input line and
 * nothing is queued into its mailbox as a peer message demanding a reply.
 * A cache READ refreshes the provider's ephemeral prompt-cache TTL at
 * roughly 0.1x the cost of the 2x rewrite a cold cache forces on the next
 * real prompt.
 *
 * Distinct from workers/keepalive.ts, which beats a *worker provider's*
 * cache on a fixed timer regardless of activity: this only beats a session
 * that has actually been idle long enough to be at risk, and only inside a
 * configured working-hours window, so it never fires while the user is
 * present at the keyboard or overnight when nobody will read the reply
 * before the cache would have expired anyway.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  fetchLiveSessions as fetchLiveSessionsDefault,
  sendToSession as sendToSessionDefault,
  type AiBrokerSessionMeta,
} from "../cli/lib/aibroker-client.js";
import { writeJsonAtomic } from "../config/json-store.js";
import { paiHomePath } from "../config/pai-home.js";
import { appendLedger } from "../workers/ledger.js";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { worktreesDir } from "../workers/worktree.js";
import { itermUuid, sessionMapPath, type SessionMapEntry } from "../workers/scope.js";
import { isRealUserPrompt, extractUserPromptText, type AssistantLine } from "../audit/session-usage.js";
import type { SessionsCacheKeepaliveConfig } from "./config.js";

// ---------------------------------------------------------------------------
// State file — per-session beat counters, rebuildable (see json-store.ts on
// when NOT to use readJsonStrict: a damaged file here just resets counters,
// never blocks the feature).
// ---------------------------------------------------------------------------

export interface SessionKeepaliveEntry {
  /** Beats sent since the last real (non-keepalive) user prompt. */
  beats: number;
  /** Identity of the last real user prompt observed, so a fresh one can be
   *  told apart from the keepalive's own echo landing back in the transcript. */
  lastRealPromptKey: string | null;
  /** ISO stamp of the last beat sent. */
  lastBeatAt: string | null;
}

export type SessionKeepaliveState = Record<string, SessionKeepaliveEntry>;

export function sessionKeepaliveStatePath(): string {
  return paiHomePath("session-keepalive.json");
}

function emptyEntry(): SessionKeepaliveEntry {
  return { beats: 0, lastRealPromptKey: null, lastBeatAt: null };
}

export function loadSessionKeepaliveState(path: string = sessionKeepaliveStatePath()): SessionKeepaliveState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionKeepaliveState;
  } catch {
    return {};
  }
}

export function saveSessionKeepaliveState(
  state: SessionKeepaliveState,
  path: string = sessionKeepaliveStatePath()
): void {
  writeJsonAtomic(path, state, { backup: false, label: path });
}

// ---------------------------------------------------------------------------
// Active-hours window
// ---------------------------------------------------------------------------

/** Parse "HH:MM-HH:MM" into minutes-since-midnight. Throws on a malformed
 *  spec — an explicit config error beats a window that is silently always
 *  on or always off. */
export function parseActiveHours(spec: string): { startMin: number; endMin: number } {
  const m = spec.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) {
    throw new Error(`sessions.cacheKeepalive.activeHours: invalid "${spec}" (want "HH:MM-HH:MM")`);
  }
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

/**
 * Whether `now` (local time) sits inside the window. A window that wraps
 * midnight (e.g. "22:00-06:00") is honoured by inverting the test instead of
 * requiring startMin < endMin.
 */
export function isWithinActiveHours(now: Date, spec: string): boolean {
  const { startMin, endMin } = parseActiveHours(spec);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

// ---------------------------------------------------------------------------
// Transcript lookup
// ---------------------------------------------------------------------------

/**
 * Full path to a live session's transcript under ~/.claude/projects, or null
 * when none is found — the case for a session too new to have written a file
 * yet. A worker running in a worktree DOES write a transcript here (Claude
 * Code encodes its worktree cwd as the project dir name), so workers are not
 * excluded "for free" — see isWorkerSession.
 */
export function findSessionTranscript(
  sessionId: string,
  projectsDir: string = join(homedir(), ".claude", "projects")
): string | null {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const projectDir of projectDirs) {
    const candidate = join(projectsDir, projectDir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * AIBroker's `fetchLiveSessions()` identifies a session by its iTerm2 pane id
 * (e.g. an AIBroker/iTerm UUID), not the Claude session id `<uuid>.jsonl`
 * transcripts are named after — the two are unrelated identifiers. The
 * status line bridges them on every refresh via `claude-session-map.json`
 * (see `recordSessionMapEntry` in ../workers/scope.ts): this picks, among the
 * map entries whose `term` pane UUID matches, the most recently written one.
 * Returns null when the pane has no (fresh enough) mapped Claude session.
 */
export function resolveClaudeSessionIdFromMap(paneId: string, logDir: string): string | null {
  const path = sessionMapPath(logDir);
  if (!paneId || !existsSync(path)) return null;
  let map: Record<string, SessionMapEntry>;
  try {
    map = JSON.parse(readFileSync(path, "utf8")) as Record<string, SessionMapEntry>;
  } catch {
    return null;
  }
  let best: SessionMapEntry | null = null;
  for (const entry of Object.values(map)) {
    if (!entry.term || itermUuid(entry.term) !== paneId) continue;
    if (!best || entry.ts > best.ts) best = entry;
  }
  return best?.session ?? null;
}

/** Claude Code's project-dir encoding of a cwd: every "/" becomes "-". */
function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Is this live "claude"-kind session actually a worker pane rather than an
 * interactive one? `claude -p` workers running in a worktree write their
 * transcript under ~/.claude/projects too (encoded cwd = the worktree dir),
 * so a missing transcript is NOT how workers get excluded — this predicate
 * is. Either signal is enough:
 *   (a) the transcript's project-dir name is the encoded form of a path
 *       under <logDir>/worktrees (every worker worktree lives there), or
 *   (b) the broker's session name/paiName names a path under the workers
 *       log dir or one of its worktrees (best-effort: AIBroker does not
 *       guarantee this, but honors it when present).
 */
export function isWorkerSession(
  meta: AiBrokerSessionMeta,
  transcriptPath: string | null,
  logDir: string
): boolean {
  const worktreesPrefix = encodeProjectDirName(worktreesDir(logDir));
  if (transcriptPath) {
    const projectDirName = transcriptPath.split("/").slice(0, -1).pop() ?? "";
    if (projectDirName.startsWith(worktreesPrefix)) return true;
  }
  const rawPrefix = worktreesDir(logDir);
  for (const field of [meta.name, meta.paiName]) {
    if (field && (field.includes(rawPrefix) || field.includes(logDir))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tail snapshot: last turn's context, mid-turn flag, last real prompt
// ---------------------------------------------------------------------------

export interface TranscriptSnapshot {
  /** cache_read + cache_creation + input on the most recent assistant turn seen. */
  context: number | null;
  /** True when the last line in the file shows the session still working: an
   *  assistant turn with no usage yet (streaming) or a stop_reason other than
   *  end_turn/stop_sequence (e.g. mid tool-call), or a real user prompt with
   *  no reply behind it yet. A beat sent now would land mid-generation. */
  midTurn: boolean;
  /** The last real (human-authored) user prompt seen, if any. */
  lastRealPrompt: { key: string; text: string } | null;
}

function isMidTurn(line: AssistantLine | null): boolean {
  if (!line) return false;
  if (line.type === "user" && isRealUserPrompt(line)) return true;
  if (line.type === "assistant") {
    const stopReason = line.message?.stop_reason;
    if (stopReason === undefined || stopReason === null) return true;
    return stopReason !== "end_turn" && stopReason !== "stop_sequence";
  }
  return false;
}

export function readTranscriptSnapshot(path: string): TranscriptSnapshot {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return { context: null, midTurn: false, lastRealPrompt: null };
  }

  let lastLine: AssistantLine | null = null;
  let context: number | null = null;
  let lastRealPrompt: { key: string; text: string } | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj: AssistantLine;
    try {
      obj = JSON.parse(raw) as AssistantLine;
    } catch {
      continue;
    }
    if (lastLine === null) lastLine = obj;

    if (context === null && obj.type === "assistant" && obj.message?.usage) {
      const usage = obj.message.usage;
      context =
        (Number(usage.cache_read_input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.input_tokens) || 0);
    }

    if (lastRealPrompt === null && isRealUserPrompt(obj)) {
      const key = obj.uuid ?? obj.timestamp ?? String(i);
      lastRealPrompt = { key, text: extractUserPromptText(obj).trim() };
    }

    if (context !== null && lastRealPrompt !== null) break;
  }

  return { context, midTurn: isMidTurn(lastLine), lastRealPrompt };
}

// ---------------------------------------------------------------------------
// Ledger — same file WORKER-KEEPALIVE lines go to (workers.logDir/ledger.log)
// ---------------------------------------------------------------------------

/** Ledger event tag; `pai daemon keepalive` and any log-tailer key off this. */
export const SESSION_KEEPALIVE_EVENT = "SESSION-KEEPALIVE";

export function sessionKeepaliveLedgerPath(): string {
  const { workers } = readWorkersSection();
  return join(workersLogDir(workers), "ledger.log");
}

/** The counts/last lines `pai daemon keepalive` prints, scoped to this event. */
export function sessionKeepaliveLedgerSummary(
  path: string = sessionKeepaliveLedgerPath(),
  lastN = 10
): { sent: number; skipped: number; lastLines: string[] } {
  if (!existsSync(path)) return { sent: 0, skipped: 0, lastLines: [] };
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.includes(SESSION_KEEPALIVE_EVENT));
  const sent = lines.filter((l) => / result=sent(\s|$)/.test(l)).length;
  return { sent, skipped: lines.length - sent, lastLines: lines.slice(-lastN) };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface SessionKeepaliveDeps {
  now: () => Date;
  fetchLiveSessions: () => Promise<AiBrokerSessionMeta[]>;
  /** AIBroker pane id (fetchLiveSessions' `sessionId`) -> Claude transcript
   *  session id, via the status line's claude-session-map.json bridge. */
  resolveClaudeSessionId: (paneId: string) => string | null;
  findTranscript: (sessionId: string) => string | null;
  mtimeMs: (path: string) => number | null;
  readSnapshot: (path: string) => TranscriptSnapshot;
  sendBeat: (sessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  loadState: () => SessionKeepaliveState;
  saveState: (s: SessionKeepaliveState) => void;
  ledger: (kv: Record<string, string | number | null | undefined>) => void;
}

export interface SessionKeepaliveResult {
  sessionId: string;
  result: "sent" | string; // "skipped:<reason>"
}

function defaultDeps(): SessionKeepaliveDeps {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  return {
    now: () => new Date(),
    fetchLiveSessions: fetchLiveSessionsDefault,
    resolveClaudeSessionId: (paneId) => resolveClaudeSessionIdFromMap(paneId, logDir),
    findTranscript: (id) => findSessionTranscript(id),
    mtimeMs: (p) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return null;
      }
    },
    readSnapshot: readTranscriptSnapshot,
    sendBeat: (id, text) => sendToSessionDefault(id, text, undefined, { noReply: true }),
    loadState: () => loadSessionKeepaliveState(),
    saveState: (s) => saveSessionKeepaliveState(s),
    ledger: (kv) => appendLedger(sessionKeepaliveLedgerPath(), SESSION_KEEPALIVE_EVENT, kv),
  };
}

/**
 * One tick over every live interactive session: beat the ones that qualify,
 * skip (with a reason) the ones that don't. Returns one result per live
 * "claude"-kind session for tests to assert against; writes the ledger line
 * and (when any counter changed) the state file as side effects.
 */
export async function runSessionKeepaliveTick(
  config: SessionsCacheKeepaliveConfig,
  overrides: Partial<SessionKeepaliveDeps> = {}
): Promise<SessionKeepaliveResult[]> {
  if (!config.enabled) return [];

  const d: SessionKeepaliveDeps = { ...defaultDeps(), ...overrides };
  const sessions = await d.fetchLiveSessions();
  const state = d.loadState();
  const now = d.now();
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  const results: SessionKeepaliveResult[] = [];
  let anyChanged = false;

  for (const s of sessions) {
    if (s.kind !== "claude") continue;
    const paneId = s.sessionId;

    const claudeId = d.resolveClaudeSessionId(paneId);
    if (!claudeId) {
      d.ledger({ session: null, pane: paneId, result: "skipped:unmapped" });
      results.push({ sessionId: paneId, result: "skipped:unmapped" });
      continue;
    }
    const sessionId = claudeId;
    const entry = { ...(state[sessionId] ?? emptyEntry()) };
    let changed = false;

    const transcript = d.findTranscript(sessionId);

    if (isWorkerSession(s, transcript, logDir)) {
      d.ledger({ session: sessionId, pane: paneId, result: "skipped:worker" });
      results.push({ sessionId, result: "skipped:worker" });
      continue;
    }

    if (!transcript) {
      d.ledger({ session: sessionId, pane: paneId, result: "skipped:no-transcript" });
      results.push({ sessionId, result: "skipped:no-transcript" });
      continue;
    }

    const snapshot = d.readSnapshot(transcript);

    // A fresh real prompt (not the keepalive's own echo) resets the beat
    // count — the idle stretch it capped is over.
    if (snapshot.lastRealPrompt && snapshot.lastRealPrompt.key !== entry.lastRealPromptKey) {
      entry.lastRealPromptKey = snapshot.lastRealPrompt.key;
      if (snapshot.lastRealPrompt.text !== config.prompt) entry.beats = 0;
      changed = true;
    }

    const mtime = d.mtimeMs(transcript);
    const idleMin = mtime === null ? null : (now.getTime() - mtime) / 60_000;

    const skip: string | null =
      mtime === null || idleMin === null
        ? "no-mtime"
        : idleMin < config.idleMinutes
          ? `idle:${idleMin.toFixed(1)}min`
          : !isWithinActiveHours(now, config.activeHours)
            ? "hours"
            : snapshot.context === null || snapshot.context < config.minContextTokens
              ? "context"
              : snapshot.midTurn
                ? "mid-turn"
                : entry.beats >= config.maxBeats
                  ? "max-beats"
                  : null;

    const ledgerBase = {
      session: sessionId,
      pane: paneId,
      idle_min: idleMin === null ? null : idleMin.toFixed(1),
      context: snapshot.context,
    };

    if (skip) {
      d.ledger({ ...ledgerBase, beat: `${entry.beats}/${config.maxBeats}`, result: `skipped:${skip}` });
      results.push({ sessionId, result: `skipped:${skip}` });
    } else {
      const sent = await d.sendBeat(paneId, config.prompt);
      if (sent.ok) {
        entry.beats += 1;
        entry.lastBeatAt = now.toISOString();
        changed = true;
        d.ledger({ ...ledgerBase, beat: `${entry.beats}/${config.maxBeats}`, result: "sent" });
        results.push({ sessionId, result: "sent" });
      } else {
        d.ledger({ ...ledgerBase, beat: `${entry.beats}/${config.maxBeats}`, result: "skipped:send-failed" });
        results.push({ sessionId, result: "skipped:send-failed" });
      }
    }

    if (changed) {
      state[sessionId] = entry;
      anyChanged = true;
    }
  }

  if (anyChanged) d.saveState(state);
  return results;
}

