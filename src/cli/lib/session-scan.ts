/**
 * Shared scanner for Claude Code sessions stored in ~/.claude/projects/ .
 *
 * Storage layout (Claude Code v2.1.143+):
 *
 *   <project>/<uuid>.jsonl          — top-level: metadata, system snapshots, hook events.
 *                                     REQUIRED for claude --resume to work.
 *   <project>/sessions/<uuid>.jsonl — full transcript: user/assistant/attachment lines.
 *                                     3000+ files, almost none resumable on their own.
 *
 * Resumability rule (empirically verified):
 *   A session is resumable iff the TOP-LEVEL jsonl exists AND contains at least one
 *   line of type "system". Sessions that only have a sessions/ counterpart cannot be
 *   resumed by Claude Code regardless of how much transcript content they have.
 *
 * Stale-UUID problem (fixed in this version):
 *   The clc session.json registry stores ONE uuid per named session — the uuid Claude Code
 *   had when the user last named the session. If the user resumes and the session gets a
 *   new uuid (or they Ctrl+C and start fresh), the registry entry still points to the OLD
 *   uuid. The scanner now resolves names to the MOST RECENT top-level jsonl in the project
 *   directory, not the clc-cached uuid.
 *
 * Resolution strategy:
 *   1. Walk top-level <project>/<uuid>.jsonl files (Pass 1).
 *   2. For each, attach the clc name if the uuid matches (exact hit).
 *   3. After Pass 1, for every clc registry entry:
 *      a. If the cached uuid was found → already handled.
 *      b. Find the encodedDir for this entry's directory.
 *      c. Check ALL sessions in that encodedDir (already in our Pass-1 results).
 *      d. Pick the MOST RECENT resumable session in that dir and attach the name to it.
 *         If no resumable session, fall through to transcript-only pass.
 *   4. This means the displayed uuid for "Jobs Matthias" is always today's active session,
 *      not the stale cached one.
 *
 * Used by: pai sessions, pai resume
 */

import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { Database } from "better-sqlite3";
import { smartDecodeDir } from "../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Display status for a session:
 *   resumable       — top-level jsonl exists with ≥1 system line (claude --resume works)
 *   stub            — in clc registry, top-level jsonl exists but 0 system lines (Ctrl+C exit)
 *   transcript-only — in clc registry but no top-level jsonl at all
 *   orphan          — not in clc registry, only sessions/ transcript exists
 */
export type SessionStatus = "resumable" | "stub" | "transcript-only" | "orphan";

export interface ScannedSession {
  /** Full UUID from the filename. */
  uuid: string;
  /** Short 8-char prefix for display. */
  shortId: string;
  /** Encoded project directory name (e.g. "-Users-foo-myproject"). */
  encodedDir: string;
  /** Decoded project root path (via smartDecodeDir). */
  decodedPath: string;

  // Top-level jsonl — the resumability source
  /** Full path to the top-level <project>/<uuid>.jsonl (may not exist). */
  topLevelPath: string;
  /** Number of "system" lines in the top-level jsonl. */
  topLevelSystemLines: number;
  /** Size of the top-level jsonl in bytes. */
  topLevelSize: number;
  /**
   * True iff the top-level jsonl has at least one "system" line.
   * This is the canonical resumability gate — matches Claude Code's --resume behaviour.
   */
  resumable: boolean;
  /** Categorised display status. */
  sessionStatus: SessionStatus;

  // Sessions/ transcript data (best-effort, may not exist)
  /** Full path to sessions/<uuid>.jsonl, if present. */
  sessionJsonlPath?: string;
  /** Number of "user" type lines in the transcript. */
  userLines: number;
  /** Last user message text (truncated to 80 chars). */
  lastUserPrompt: string;
  /** Total line count in the transcript file. */
  msgCount: number;
  /** Auto-generated title from the last ai-title line in the transcript. */
  aiTitle?: string;

  /** mtime in epoch ms — top-level file mtime (primary), transcript mtime (fallback). */
  mtime: number;

  /**
   * Human-readable friendly name (for display and /Name restoration).
   * Priority: clc session.json name → ai-title → project dir basename.
   * NEVER slugified — preserves original spaces and capitalisation.
   */
  friendlyName?: string;
  /**
   * Literal directory from the clc session registry for this UUID.
   * May contain symlinks and emoji (e.g. /Users/foo/dev/... or .../🧠 Vault/...).
   * When present, realpathSync(clcDirectory) gives the correct cwd for --resume.
   */
  clcDirectory?: string;
  /** Project root path from PAI registry (authoritative cwd for resume). */
  registryRootPath?: string;
}

// ---------------------------------------------------------------------------
// clc session registry (~/.claude/session.json)
// ---------------------------------------------------------------------------

const CLC_SESSIONS_FILE = join(homedir(), ".claude", "session.json");

interface ClcEntry {
  name?: string;
  resume?: string;
  session?: string;
  directory?: string;
}

interface ClcRegistry {
  sessions?: ClcEntry[];
}

export interface ClcInfo {
  name: string;
  /** Literal directory from clc registry (may contain symlinks, emoji, spaces). */
  directory?: string;
}

/** Load clc's session registry → uuid → ClcInfo map. Verbatim, never slugified. */
function buildClcInfoMap(): Map<string, ClcInfo> {
  const map = new Map<string, ClcInfo>();
  try {
    const raw = readFileSync(CLC_SESSIONS_FILE, "utf8");
    const data = JSON.parse(raw) as ClcRegistry;
    for (const entry of data.sessions ?? []) {
      const name = entry.name?.trim();
      const uuid = (entry.resume ?? entry.session ?? "").trim();
      if (name && uuid) {
        map.set(uuid, { name, directory: entry.directory?.trim() || undefined });
      }
    }
  } catch {
    // Missing or malformed — not fatal
  }
  return map;
}

// ---------------------------------------------------------------------------
// PAI registry
// ---------------------------------------------------------------------------

interface RegistryProject {
  root_path: string;
  encoded_dir: string;
}

/** Build encoded_dir → root_path map from PAI registry (authoritative cwd). */
function buildRegistryRootPathMap(db: Database): Map<string, string> {
  try {
    const rows = db
      .prepare(
        `SELECT root_path, encoded_dir FROM projects
         WHERE encoded_dir IS NOT NULL AND encoded_dir != ''`
      )
      .all() as RegistryProject[];
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.encoded_dir, row.root_path);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Top-level jsonl parser
// ---------------------------------------------------------------------------

interface TopLevelInfo {
  systemLines: number;
  size: number;
  mtime: number;
}

function parseTopLevel(filePath: string): TopLevelInfo {
  let systemLines = 0;
  let size = 0;
  let mtime = 0;
  try {
    const st = statSync(filePath);
    size = st.size;
    mtime = st.mtimeMs;
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.includes('"type":"system"') || t.includes('"type": "system"')) {
        systemLines++;
      }
    }
  } catch {
    /* ignore */
  }
  return { systemLines, size, mtime };
}

// ---------------------------------------------------------------------------
// Sessions/ transcript parser
// ---------------------------------------------------------------------------

interface TranscriptInfo {
  userLines: number;
  lastUserPrompt: string;
  msgCount: number;
  aiTitle?: string;
  mtime: number;
}

function parseTranscript(filePath: string): TranscriptInfo {
  let userLines = 0;
  let lastUserPrompt = "";
  let msgCount = 0;
  let aiTitle: string | undefined;
  let mtime = 0;

  try {
    mtime = statSync(filePath).mtimeMs;
  } catch {
    return { userLines: 0, lastUserPrompt: "", msgCount: 0, mtime: 0 };
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return { userLines: 0, lastUserPrompt: "", msgCount: 0, mtime };
  }

  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    msgCount++;

    const hasUser = t.includes('"type":"user"') || t.includes('"type": "user"');
    const hasTitle =
      t.includes('"type":"ai-title"') || t.includes('"type": "ai-title"');
    if (!hasUser && !hasTitle) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === "ai-title") {
      const v = parsed.title ?? parsed.name;
      if (typeof v === "string" && v.trim()) aiTitle = v.trim();
      continue;
    }

    if (parsed.type !== "user") continue;
    userLines++;

    const msg = parsed.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const c = msg.content;
    let text = "";
    if (typeof c === "string") {
      text = c;
    } else if (Array.isArray(c) && c.length > 0) {
      const first = c[0] as Record<string, unknown>;
      if (typeof first.text === "string") text = first.text;
    }
    if (text) lastUserPrompt = text.slice(0, 80).replace(/\n/g, " ");
  }

  return { userLines, lastUserPrompt, msgCount, aiTitle, mtime };
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Maximum results to return after sorting (default: 200). */
  limit?: number;
  /**
   * Filter mode:
   *   "named"   (default) — resumable OR in clc registry (named sessions the user cares about)
   *   "all"     — everything including unnamed orphans
   *   "resumable" — only sessions claude --resume accepts (top-level + system lines)
   */
  filter?: "named" | "all" | "resumable";
  /**
   * @deprecated Use filter instead. When true → filter:"resumable", false → filter:"named".
   * Kept for backwards compatibility with callers that predate the filter field.
   */
  resumableOnly?: boolean;
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// UUID format: 8-4-4-4-12 hex digits
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compute the effective filter mode, resolving the legacy resumableOnly flag.
 */
function resolveFilter(opts: ScanOptions): "named" | "all" | "resumable" {
  if (opts.filter) return opts.filter;
  if (opts.resumableOnly === true) return "resumable";
  if (opts.resumableOnly === false) return "all";
  return "named"; // default
}

/**
 * Scan ~/.claude/projects/ for all Claude Code sessions.
 *
 * Pass 1: walk top-level <project>/<uuid>.jsonl files (the resumability source).
 * Pass 2: handle clc registry entries whose cached UUID was not found in Pass 1.
 *         For each such entry, scan the entry's project dir for the FRESHEST session
 *         and attach the registry name to it. This fixes the stale-UUID bug where
 *         clc's session.json points to an old uuid after a fresh start.
 * Pass 3: any remaining clc entries with truly no top-level jsonl → transcript-only.
 *
 * Filter modes:
 *   "named"     — resumable + registry-known stubs + transcript-only (default)
 *   "all"       — all of the above + unnamed orphans from sessions/ subdirs
 *   "resumable" — only sessions claude --resume accepts
 *
 * Returns results sorted by mtime descending.
 */
export function scanSessions(
  db: Database,
  opts: ScanOptions = {}
): ScannedSession[] {
  const limit = opts.limit ?? 200;
  const filterMode = resolveFilter(opts);

  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const clcInfoMap = buildClcInfoMap();
  const rootPathMap = buildRegistryRootPathMap(db);
  const results: ScannedSession[] = [];
  // Track which UUIDs we've already added (from the jsonl walk)
  const seenUuids = new Set<string>();
  // Track which clc names we've already attached to a session
  const attachedClcUuids = new Set<string>();

  let encodedDirs: string[];
  try {
    encodedDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  // Build a map: encodedDir → all top-level sessions found in Pass 1
  // This is used in Pass 2 to find the freshest session for a clc registry entry.
  const sessionsByEncodedDir = new Map<string, ScannedSession[]>();

  // ---- Pass 1: walk top-level <project>/<uuid>.jsonl files ----
  for (const encodedDir of encodedDirs) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, encodedDir);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(projectDir);
    } catch {
      continue;
    }

    const decodedPath =
      smartDecodeDir(encodedDir) ?? encodedDir.replace(/-/g, "/");
    const registryRootPath = rootPathMap.get(encodedDir);
    const projectBasename = basename(decodedPath);

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const uuid = file.slice(0, -6);
      if (!UUID_RE.test(uuid)) continue;

      const topLevelPath = join(projectDir, file);
      const topInfo = parseTopLevel(topLevelPath);
      const resumable = topInfo.systemLines > 0;
      const clcInfo = clcInfoMap.get(uuid);
      const inRegistry = !!clcInfo;

      // Determine status
      const sessionStatus: SessionStatus = resumable
        ? "resumable"
        : inRegistry
          ? "stub"
          : "orphan";

      // Apply filter — but include ALL in this pass so Pass 2 can use them
      // We'll filter again when deciding what to add to `results`.
      const passesFilter =
        filterMode === "resumable"
          ? resumable
          : filterMode === "named"
            ? resumable || inRegistry
            : true;

      // Join with sessions/ transcript (best-effort)
      const sessionJsonlPath = join(projectDir, "sessions", `${uuid}.jsonl`);
      const hasTranscript = existsSync(sessionJsonlPath);
      const transcript: TranscriptInfo = hasTranscript
        ? parseTranscript(sessionJsonlPath)
        : { userLines: 0, lastUserPrompt: "", msgCount: 0, mtime: 0 };

      // Use top-level mtime as primary
      const mtime = topInfo.mtime || transcript.mtime;

      // Name resolution: clc registry (verbatim) → ai-title → project basename
      const friendlyName =
        clcInfo?.name ?? transcript.aiTitle ?? projectBasename ?? undefined;

      const session: ScannedSession = {
        uuid,
        shortId: uuid.slice(0, 8),
        encodedDir,
        decodedPath,
        topLevelPath,
        topLevelSystemLines: topInfo.systemLines,
        topLevelSize: topInfo.size,
        resumable,
        sessionStatus,
        sessionJsonlPath: hasTranscript ? sessionJsonlPath : undefined,
        userLines: transcript.userLines,
        lastUserPrompt: transcript.lastUserPrompt,
        msgCount: transcript.msgCount,
        aiTitle: transcript.aiTitle,
        mtime,
        friendlyName,
        clcDirectory: clcInfo?.directory,
        registryRootPath,
      };

      // Track in per-dir map for Pass 2 lookups (all sessions, regardless of filter)
      if (!sessionsByEncodedDir.has(encodedDir)) {
        sessionsByEncodedDir.set(encodedDir, []);
      }
      sessionsByEncodedDir.get(encodedDir)!.push(session);

      seenUuids.add(uuid);
      if (inRegistry) attachedClcUuids.add(uuid);

      if (passesFilter) {
        results.push(session);
      }
    }
  }

  // ---- Pass 2: clc registry entries whose cached UUID wasn't found as a top-level file ----
  // For each such entry, find the project's encodedDir and look for the FRESHEST
  // resumable session there. Attach the clc name to it.
  // This fixes the stale-UUID bug: clc may store a uuid that's no longer valid,
  // but the project dir has a new active session the user is actually in.
  if (filterMode !== "resumable") {
    for (const [cachedUuid, clcInfo] of clcInfoMap) {
      if (attachedClcUuids.has(cachedUuid)) continue; // already named in Pass 1

      // Derive the encodedDir from clcInfo.directory
      let foundEncodedDir: string | undefined;
      if (clcInfo.directory) {
        const real = realpathSyncSafe(clcInfo.directory);
        if (real) {
          const encoded = encodeProjectDir(real);
          if (existsSync(join(CLAUDE_PROJECTS_DIR, encoded))) {
            foundEncodedDir = encoded;
          }
        }
      }

      // Fallback: check if the cached uuid exists as a sessions/ transcript somewhere
      if (!foundEncodedDir) {
        for (const encodedDir of encodedDirs) {
          if (existsSync(join(CLAUDE_PROJECTS_DIR, encodedDir, "sessions", `${cachedUuid}.jsonl`))) {
            foundEncodedDir = encodedDir;
            break;
          }
        }
      }

      if (foundEncodedDir) {
        const dirSessions = sessionsByEncodedDir.get(foundEncodedDir) ?? [];

        // Find the freshest RESUMABLE session in this dir that doesn't yet have a name
        const freshestResumable = dirSessions
          .filter((s) => s.resumable && !s.friendlyName)
          .sort((a, b) => b.mtime - a.mtime)[0];

        if (freshestResumable) {
          // Attach the clc name to this fresher session
          freshestResumable.friendlyName = clcInfo.name;
          freshestResumable.clcDirectory =
            freshestResumable.clcDirectory ?? clcInfo.directory;
          freshestResumable.sessionStatus = "resumable";
          attachedClcUuids.add(freshestResumable.uuid);

          // Add to results if not already there (it might have been filtered out as orphan)
          if (!seenUuids.has(freshestResumable.uuid) || !results.includes(freshestResumable)) {
            // It was added to sessionsByEncodedDir but might have been filtered from results
            if (!results.includes(freshestResumable)) {
              results.push(freshestResumable);
            }
          }
          continue; // Done with this clc entry
        }

        // No unnamed resumable session found. The project might have resumable sessions
        // that already have a name (different name). Or only stubs/orphans.
        // Fall through to transcript-only handling below.
      }

      // ---- Pass 3: truly no top-level jsonl → transcript-only ----
      if (!foundEncodedDir) {
        // We couldn't find the project dir at all
        const encodedDir = "";
        const decodedPath = clcInfo.directory ?? cachedUuid;
        const registryRootPath = undefined;

        const transcript: TranscriptInfo = { userLines: 0, lastUserPrompt: "", msgCount: 0, mtime: 0 };
        const mtime = transcript.mtime;

        seenUuids.add(cachedUuid);
        results.push({
          uuid: cachedUuid,
          shortId: cachedUuid.slice(0, 8),
          encodedDir,
          decodedPath,
          topLevelPath: "",
          topLevelSystemLines: 0,
          topLevelSize: 0,
          resumable: false,
          sessionStatus: "transcript-only",
          sessionJsonlPath: undefined,
          userLines: 0,
          lastUserPrompt: "",
          msgCount: 0,
          mtime,
          friendlyName: clcInfo.name,
          clcDirectory: clcInfo.directory,
          registryRootPath,
        });
        continue;
      }

      // Project dir was found but no unnamed resumable session.
      // Check sessions/ for the cached uuid transcript.
      const foundTranscriptPath = existsSync(
        join(CLAUDE_PROJECTS_DIR, foundEncodedDir, "sessions", `${cachedUuid}.jsonl`)
      )
        ? join(CLAUDE_PROJECTS_DIR, foundEncodedDir, "sessions", `${cachedUuid}.jsonl`)
        : undefined;

      const decodedPath =
        clcInfo.directory ??
        (smartDecodeDir(foundEncodedDir) ?? foundEncodedDir.replace(/-/g, "/"));
      const registryRootPath = rootPathMap.get(foundEncodedDir);
      const topLevelPath = join(
        CLAUDE_PROJECTS_DIR,
        foundEncodedDir,
        `${cachedUuid}.jsonl`
      );

      const transcript: TranscriptInfo = foundTranscriptPath
        ? parseTranscript(foundTranscriptPath)
        : { userLines: 0, lastUserPrompt: "", msgCount: 0, mtime: 0 };

      seenUuids.add(cachedUuid);
      results.push({
        uuid: cachedUuid,
        shortId: cachedUuid.slice(0, 8),
        encodedDir: foundEncodedDir,
        decodedPath,
        topLevelPath,
        topLevelSystemLines: 0,
        topLevelSize: 0,
        resumable: false,
        sessionStatus: "transcript-only",
        sessionJsonlPath: foundTranscriptPath,
        userLines: transcript.userLines,
        lastUserPrompt: transcript.lastUserPrompt,
        msgCount: transcript.msgCount,
        aiTitle: transcript.aiTitle,
        mtime: transcript.mtime,
        friendlyName: clcInfo.name,
        clcDirectory: clcInfo.directory,
        registryRootPath,
      });
    }
  }

  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Path encoding helpers
// ---------------------------------------------------------------------------

/** Claude Code's project-dir encoding: replace /  .  -  (space) with - */
function encodeProjectDir(realPath: string): string {
  // Leading slash becomes leading -; all / . - and space → -
  return realPath.replace(/[/.\- ]/g, "-");
}

/** realpathSync that returns null instead of throwing */
function realpathSyncSafe(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Age formatter
// ---------------------------------------------------------------------------

export function fmtAge(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay < 30) return `${diffDay}d`;
  return `${Math.floor(diffDay / 30)}mo`;
}

// ---------------------------------------------------------------------------
// Resolve a name/id/prefix to a session entry
// ---------------------------------------------------------------------------

export interface ResolvedSession {
  session: ScannedSession;
  /** The friendly name to use verbatim in the /Name command. Never slugified. */
  friendlyName?: string;
}

/**
 * Resolve a name-or-id-or-prefix to a single ScannedSession.
 *
 * Comparisons are case-insensitive; stored casing is preserved in output.
 *
 * Priority:
 *  1. Exact case-insensitive match on friendlyName
 *  2. Partial case-insensitive match (contains)
 *  3. UUID prefix match
 */
export function resolveSessionByNameOrId(
  sessions: ScannedSession[],
  query: string
): ResolvedSession {
  const qLower = query.toLowerCase().trim();

  // 1. Exact match (case-insensitive, preserve stored casing)
  const byExact = sessions.filter(
    (s) => s.friendlyName && s.friendlyName.toLowerCase() === qLower
  );
  if (byExact.length >= 1) {
    return { session: byExact[0], friendlyName: byExact[0].friendlyName };
  }

  // 2. Partial match
  const byPartial = sessions.filter(
    (s) => s.friendlyName && s.friendlyName.toLowerCase().includes(qLower)
  );
  if (byPartial.length === 1) {
    return { session: byPartial[0], friendlyName: byPartial[0].friendlyName };
  }
  if (byPartial.length > 1) {
    const candidates = byPartial
      .slice(0, 5)
      .map(
        (s, i) =>
          `  ${i + 1}. ${s.shortId}  ${s.friendlyName ?? s.decodedPath}  (${fmtAge(s.mtime)} ago)`
      )
      .join("\n");
    throw new Error(
      `Ambiguous name "${query}" — ${byPartial.length} matches:\n${candidates}\n\nBe more specific or use a UUID prefix.`
    );
  }

  // 3. UUID prefix
  const byUuid = sessions.filter((s) => s.uuid.startsWith(qLower));
  if (byUuid.length === 1) {
    return { session: byUuid[0], friendlyName: byUuid[0].friendlyName };
  }
  if (byUuid.length > 1) {
    const candidates = byUuid
      .slice(0, 5)
      .map(
        (s, i) =>
          `  ${i + 1}. ${s.shortId}  ${s.friendlyName ?? s.decodedPath}  (${fmtAge(s.mtime)} ago)`
      )
      .join("\n");
    throw new Error(
      `UUID prefix "${query}" is ambiguous — ${byUuid.length} matches:\n${candidates}\n\nProvide more characters.`
    );
  }

  throw new Error(
    `No session found matching "${query}".\n\nRun: pai sessions          to list sessions.\nRun: pai sessions --all    to include transcript-only sessions.`
  );
}
