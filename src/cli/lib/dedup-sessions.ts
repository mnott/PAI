/**
 * dedup-sessions.ts — Shared dedup catalog for `pai` and listing commands.
 *
 * Both `pai` (no args) and any listing command must show IDENTICAL output.
 * This module is the single source of truth for:
 *   - Name normalization  (strips spinner prefixes and " (node)" suffixes)
 *   - Dedup grouping      (one row per normalized name)
 *   - Priority ranking    (live > resumable > transcript-only > stub > project > orphan)
 *   - Registered projects (shown as status "idle" when no live/disk session matches)
 *   - Filtering           (hide 0-session / cold / archived projects by default)
 *   - Table rendering     (shared columns and formatting)
 *
 * Default visibility rules (overridden by showAll=true):
 *   SHOW: live sessions (always)
 *   SHOW: resumable sessions (always)
 *   SHOW: registered projects with session_count > 0 AND last_active within 90 days
 *         OR session_count >= 3 (i.e. well-used projects regardless of age)
 *   HIDE: projects with session_count = 0 (never used)
 *   HIDE: projects with last_active > 90 days AND session_count < 3 (cold)
 *   HIDE: archived projects (status != 'active')
 */

import type { Database } from "better-sqlite3";
import chalk from "chalk";
import { renderTable, dim, header, warn } from "../utils.js";
import { fmtAge, type ScannedSession } from "./session-scan.js";
import { type AiBrokerSessionMeta } from "./aibroker-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UnifiedStatus =
  | "live"
  | "resumable"
  | "transcript-only"
  | "stub"
  | "project"
  | "orphan";

export const STATUS_PRIORITY: Record<UnifiedStatus, number> = {
  live: 0,
  resumable: 1,
  "transcript-only": 2,
  stub: 3,
  project: 4,
  orphan: 5,
};

export interface UnifiedSession {
  /** Clean display name (normalized — no spinners, no "(node)") */
  name: string;
  /** Slug from the project registry (for slug-based matching in `pai <name>`) */
  slug?: string;
  status: UnifiedStatus;
  /** Only present for live sessions */
  liveSessionId?: string;
  /** Only present for disk sessions */
  diskSession?: ScannedSession;
  lastActivity: number;
  project: string;
  lastPrompt: string;
  /** For project-source entries: number of historical sessions ever */
  sessionCount?: number;
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/**
 * Strip Claude Code spinner characters, decoration prefixes, and " (node)" suffixes
 * from a session name so that "✳ Chenarlier (node)" and "Chenarlier" group together.
 *
 * Handles:
 *   - Unicode braille spinner frames: ⠐ ⠂ ⠁ ⠈ ⠘ ⠙ ⠚ ⠛ ⠗ ⠝
 *   - Decoration characters: ✻ ✳ ✲ ✼ ✦ * ★ ☆ • ●
 *   - Any leading non-letter/digit characters followed by whitespace
 *   - Trailing " (node)" suffix (Claude Code appends this on some platforms)
 */
export function normalizeName(s: string): string {
  return s
    // Strip leading spinner / decoration characters (braille + symbols)
    .replace(/^[⠀-⣿✀-➿✻✳✲✼✦*★☆•●⠐⠂⠁⠈⠘⠙⠚⠛⠗⠝]+\s*/u, "")
    // Strip any remaining leading non-alphanumeric prefix before whitespace
    .replace(/^[^a-zA-Z0-9À-ÿ　-鿿]+\s*/u, "")
    // Strip trailing " (node)" suffix
    .replace(/\s*\(node\)\s*$/i, "")
    .trim();
}

/**
 * Normalize a slug (kebab-case) to a human-readable form for matching.
 * "jobs-grazyna" → "jobs grazyna"
 */
function slugToWords(slug: string): string {
  return slug.replace(/-/g, " ");
}

// ---------------------------------------------------------------------------
// Dedup builder
// ---------------------------------------------------------------------------

export interface RegisteredProject {
  slug: string;
  display_name: string;
  root_path: string;
  session_count: number;
  last_active: number | null;
  status: string;
}

/**
 * Merge live (AIBroker) + disk (session-scan) + registry (projects DB) sessions
 * into a deduped catalog.
 *
 * Algorithm:
 *   1. Normalize names before grouping
 *   2. Group by normalized name (case-insensitive)
 *   3. Within each group, rank by STATUS_PRIORITY (live wins)
 *   4. Within same priority, keep the most recent (highest mtime)
 *   5. Sort output: by priority, then by lastActivity desc
 *   6. Filter idle project entries (default) or show all (showAll=true)
 *
 * @param showAll  When true, include cold / zero-session / archived projects.
 */
export function buildDeduped(
  liveSessions: AiBrokerSessionMeta[],
  diskSessions: ScannedSession[],
  registeredProjects?: RegisteredProject[],
  showAll = false
): UnifiedSession[] {
  const byName = new Map<string, UnifiedSession>();

  // Process live Claude sessions
  for (const s of liveSessions) {
    if (s.kind === "shell") continue;
    const raw = s.paiName ?? s.name ?? s.sessionId.slice(0, 8);
    const normalized = normalizeName(raw);
    const key = normalized.toLowerCase();

    const entry: UnifiedSession = {
      name: normalized,
      status: "live",
      liveSessionId: s.sessionId,
      lastActivity: Date.now(),
      project: "",
      lastPrompt: s.lastPrompt ?? "",
    };

    const existing = byName.get(key);
    if (!existing || STATUS_PRIORITY["live"] < STATUS_PRIORITY[existing.status]) {
      byName.set(key, entry);
    }
  }

  // Process disk sessions
  for (const s of diskSessions) {
    const raw = s.friendlyName ?? s.shortId;
    const normalized = normalizeName(raw);
    const key = normalized.toLowerCase();

    let status: UnifiedStatus;
    if (s.resumable) {
      status = "resumable";
    } else if (s.sessionStatus === "transcript-only") {
      status = "transcript-only";
    } else if (s.sessionStatus === "stub") {
      status = "stub";
    } else {
      status = "orphan";
    }

    const entry: UnifiedSession = {
      name: normalized,
      status,
      diskSession: s,
      lastActivity: s.mtime,
      project: s.decodedPath ?? "",
      lastPrompt: s.lastUserPrompt ?? "",
    };

    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, entry);
    } else {
      const ep = STATUS_PRIORITY[existing.status];
      const np = STATUS_PRIORITY[status];
      if (np < ep || (np === ep && entry.lastActivity > existing.lastActivity)) {
        byName.set(key, entry);
      }
    }
  }

  // Constants for idle-project filtering
  const COLD_DAYS = 90;
  const COLD_THRESHOLD_MS = COLD_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Process registered projects — add any not already covered by live/disk entries
  if (registeredProjects) {
    for (const p of registeredProjects) {
      // Skip archived projects unless showAll
      if (!showAll && p.status !== "active") continue;

      const displayName = p.display_name ?? p.slug;
      const normalized = normalizeName(displayName);
      const key = normalized.toLowerCase();

      // Also check if slug matches (via slug→words form)
      const slugKey = slugToWords(p.slug).toLowerCase();

      if (!byName.has(key) && !byName.has(slugKey)) {
        // Apply idle-project filter unless showAll:
        //   - Hide projects with 0 sessions (never used)
        //   - Hide projects cold AND low usage: last_active > 90 days AND sessions < 3
        if (!showAll) {
          if (p.session_count === 0) continue;
          if (p.session_count < 3) {
            const lastActive = p.last_active ?? 0;
            if (now - lastActive > COLD_THRESHOLD_MS) continue;
          }
        }

        byName.set(key, {
          name: normalized,
          slug: p.slug,
          status: "project",
          lastActivity: p.last_active ?? 0,
          project: p.root_path,
          lastPrompt: "",
          sessionCount: p.session_count,
        });
      } else {
        // Already have an entry — enrich it with the slug for matching
        const existing = byName.get(key) ?? byName.get(slugKey);
        if (existing && !existing.slug) {
          existing.slug = p.slug;
        }
        if (existing && existing.sessionCount === undefined) {
          existing.sessionCount = p.session_count;
        }
      }
    }
  }

  // Sort: by priority first, then by lastActivity desc
  const entries = Array.from(byName.values());
  entries.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status];
    const pb = STATUS_PRIORITY[b.status];
    if (pa !== pb) return pa - pb;
    return b.lastActivity - a.lastActivity;
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Status formatter
// ---------------------------------------------------------------------------

export function fmtUnifiedStatus(s: UnifiedStatus): string {
  switch (s) {
    case "live":             return chalk.green("live");
    case "resumable":        return chalk.cyan("resumable");
    case "transcript-only":  return chalk.dim("transcript");
    case "stub":             return chalk.dim("stub");
    case "project":          return chalk.dim("idle");
    case "orphan":           return chalk.dim("orphan");
  }
}

// ---------------------------------------------------------------------------
// Shared table renderer
// ---------------------------------------------------------------------------

function shortenProject(p: string, maxLen = 28): string {
  if (!p || p.length <= maxLen) return p || dim("—");
  return "…" + p.slice(-(maxLen - 1));
}

/**
 * Render the deduped session catalog to stdout.
 *
 * @param entries   Output of buildDeduped()
 * @param maxRows   Maximum rows to display. undefined = no limit (for --all).
 */
export function renderDedupedSessions(entries: UnifiedSession[], maxRows?: number): void {
  if (entries.length === 0) {
    console.log(warn("No sessions found. Start Claude Code in a project directory first."));
    return;
  }

  console.log("\n" + header("Sessions") + "\n");

  const visible = maxRows !== undefined ? entries.slice(0, maxRows) : entries;
  const tableHeaders = ["#", "name", "status", "age", "project", "last prompt"];
  const tableRows = visible.map((entry, i) => {
    const age =
      entry.status === "live"
        ? chalk.green("now")
        : entry.lastActivity > 0
          ? dim(fmtAge(entry.lastActivity))
          : dim("—");
    const snippet = entry.lastPrompt.replace(/\n+/g, " ").trim().slice(0, 36);
    const projectPath =
      entry.diskSession
        ? entry.diskSession.friendlyName ?? entry.diskSession.decodedPath
        : entry.project;
    const project = dim(shortenProject(projectPath, 28));
    return [
      dim(String(i + 1)),
      chalk.white(entry.name),
      fmtUnifiedStatus(entry.status),
      age,
      project,
      chalk.dim(snippet ? `"${snippet}"` : "—"),
    ];
  });

  console.log(renderTable(tableHeaders, tableRows));

  if (maxRows !== undefined && entries.length > maxRows) {
    console.log(dim(`  … ${entries.length - maxRows} more — use --all to show everything`));
  }

  console.log();
  console.log(
    dim("  Switch/resume/start: ") +
    chalk.white("pai <name>") +
    dim("  or  ") +
    chalk.white("pai <uuid-prefix>")
  );
  console.log();
}
