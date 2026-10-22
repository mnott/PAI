/**
 * Migration helper: imports the existing JSON session-registry into the
 * registry backend (SQLite or Postgres).
 *
 * Source file:  ~/.claude/session-registry.json
 * Target:       RegistryBackend → projects + sessions tables
 *
 * The JSON registry uses encoded directory names as keys (Claude Code's
 * encoding: leading `/` is replaced by `-`, then each remaining `/` is also
 * replaced by `-`).  This module reverses that encoding to recover the real
 * filesystem path.
 *
 * Session note filenames are expected in one of two formats:
 *   Modern:  "NNNN - YYYY-MM-DD - Description.md"   (space-dash-space)
 *   Legacy:  "NNNN_YYYY-MM-DD_description.md"        (underscores)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RegistryBackend } from "../storage/registry-interface.js";
import { smartDecodeDir } from "../cli/lib/utils.js";
import { claudeHomeDir } from "../config/pai-home.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a single entry in session-registry.json */
interface RegistryEntry {
  /** Absolute path to the Notes/ directory for this project */
  notesDir?: string;
  /** Display name stored in the registry (optional) */
  displayName?: string;
  /** Any other keys the file might carry */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Extract project entries from a parsed session-registry.json. Supports both
 * formats:
 *   list-based:   { "projects": [ { "encoded_dir", "original_path" }, ... ] }
 *   object-keyed: { "<encoded_dir>": { ... } }  (original Claude format)
 * The `version` key and non-object values are not projects.
 */
function parseRegistryEntries(
  parsed: unknown
): Array<{ encodedDir: string; entry: RegistryEntry }> {
  const out: Array<{ encodedDir: string; entry: RegistryEntry }> = [];
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.projects)) {
    for (const item of obj.projects) {
      if (!item || typeof item !== "object") continue;
      const entry = item as RegistryEntry;
      const key = entry.encoded_dir;
      if (typeof key === "string" && key) out.push({ encodedDir: key, entry });
    }
    return out;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "version") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    out.push({ encodedDir: key, entry: value as RegistryEntry });
  }
  return out;
}

/**
 * Build a lookup table from session-registry.json mapping encoded_dir →
 * original_path.  This is the authoritative source for decoding because the
 * encoding is ambiguous: `/`, ` ` (space), `.` (dot), and `-` (literal
 * hyphen) all map to `-` or `--` in ways that cannot be uniquely reversed.
 *
 * Example:
 *   `-Users-alice--ssh`  encodes  `/Users/alice/.ssh`
 *   `-Users-alice-dev-projects-04---My-App-My-App-2020---2029`
 *                        encodes  `/Users/alice/dev/projects/04 - My-App/My-App 2020 - 2029`
 *
 * @param jsonPath  Path to session-registry.json.
 *                  Defaults to ~/.claude/session-registry.json.
 * @returns Map from encoded_dir → original_path, or empty map if the file is
 *          missing / unparseable.
 */
export function buildEncodedDirMap(
  jsonPath: string = join(claudeHomeDir(), "session-registry.json")
): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(jsonPath)) return map;

  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown;
    for (const { encodedDir, entry } of parseRegistryEntries(parsed)) {
      const val = entry.original_path;
      if (typeof val === "string" && val) map.set(encodedDir, val);
    }
  } catch {
    // Unparseable — return empty map; callers fall back to heuristic decode
  }

  return map;
}

/**
 * Reverse Claude Code's directory encoding.
 *
 * Claude Code's actual encoding rules:
 *   - `/` (path separator) → `-`
 *   - ` ` (space)          → `--`  (escaped)
 *   - `.` (dot)            → `--`  (escaped)
 *   - `-` (literal hyphen) → `--`  (escaped)
 *
 * Because space, dot, and hyphen all encode to `--`, the encoding is
 * **lossy** — you cannot unambiguously reverse it.  This function therefore
 * provides a *best-effort* heuristic decode (treating `--` as a literal `-`
 * which gives wrong results for paths with spaces or dots).
 *
 * PREFER using {@link buildEncodedDirMap} to get the authoritative mapping
 * from session-registry.json instead of calling this function directly.
 *
 * Examples (best-effort, may be wrong for paths with spaces/dots):
 *   `-Users-alice-dev-apps-MyProject` → `/Users/alice/dev/apps/MyProject`
 *   `-Users-alice--ssh`               → `/Users/alice/-ssh` ← WRONG (actually .ssh)
 *
 * @param encoded   The Claude-encoded directory name.
 * @param lookupMap Optional authoritative map from {@link buildEncodedDirMap}.
 *                  If provided and the key is found, that value is returned
 *                  instead of the heuristic result.
 */
export function decodeEncodedDir(
  encoded: string,
  lookupMap?: Map<string, string>
): string {
  // Authoritative lookup wins — but only if the path actually exists on disk.
  // session-registry.json may contain stale or incorrectly decoded paths.
  if (lookupMap?.has(encoded)) {
    const mapped = lookupMap.get(encoded)!;
    if (existsSync(mapped)) return mapped;
  }

  // Filesystem-walking decode (handles spaces, dots, hyphens correctly)
  const smart = smartDecodeDir(encoded);
  if (smart) return smart;

  // Fall back to lookup map even if path doesn't exist (for display purposes)
  if (lookupMap?.has(encoded)) {
    return lookupMap.get(encoded)!;
  }

  // Last resort: every `-` maps to `/` (wrong for paths with spaces/dots/hyphens)
  if (encoded.startsWith("-")) {
    return encoded.replace(/-/g, "/");
  }

  // Not a Claude-encoded path — return as-is
  return encoded;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/**
 * Derive a URL-safe kebab-case slug from an arbitrary string.
 *
 * Uses the last path component so that `/Users/alice/dev/my-app` → `my-app`.
 */
export function slugify(value: string): string {
  // Take last path segment if it looks like a path
  const segment = value.includes("/")
    ? value.replace(/\/$/, "").split("/").pop() ?? value
    : value;

  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric runs → single dash
    .replace(/^-+|-+$/g, "");    // trim leading/trailing dashes
}

/** Stable slug for names slugify() reduces to nothing (e.g. non-ASCII only). */
export function fallbackSlug(value: string): string {
  return "project-" + createHash("sha1").update(value).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Session note parsing
// ---------------------------------------------------------------------------

interface ParsedSession {
  number: number;
  date: string;
  slug: string;
  title: string;
  filename: string;
}

/** Match `0027 - 2026-01-04 - Some Description.md` */
const MODERN_RE = /^(\d{4})\s+-\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+)\.md$/i;

/** Match `0027_2026-01-04_some_description.md` */
const LEGACY_RE = /^(\d{4})_(\d{4}-\d{2}-\d{2})_(.+)\.md$/i;

/**
 * Attempt to parse a session note filename into its structured parts.
 *
 * Returns `null` if the filename does not match either known format.
 */
export function parseSessionFilename(
  filename: string
): ParsedSession | null {
  let m = MODERN_RE.exec(filename);
  if (m) {
    const [, num, date, description] = m;
    return {
      number: parseInt(num, 10),
      date,
      slug: slugify(description),
      title: description.trim(),
      filename,
    };
  }

  m = LEGACY_RE.exec(filename);
  if (m) {
    const [, num, date, rawDesc] = m;
    const description = rawDesc.replace(/_/g, " ");
    return {
      number: parseInt(num, 10),
      date,
      slug: slugify(description),
      title: description.trim(),
      filename,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface MigrationResult {
  projectsInserted: number;
  projectsSkipped: number;
  sessionsInserted: number;
  errors: string[];
}

/**
 * Migrate the existing JSON session-registry into the registry backend.
 *
 * @param backend       Target RegistryBackend (SQLite or Postgres).
 * @param registryPath  Path to session-registry.json.
 *                      Defaults to ~/.claude/session-registry.json.
 *
 * The migration is idempotent: projects and sessions that already exist
 * (matched by slug / project_id+number) are silently skipped.
 */
export async function migrateFromJson(
  backend: RegistryBackend,
  registryPath: string = join(claudeHomeDir(), "session-registry.json")
): Promise<MigrationResult> {
  const result: MigrationResult = {
    projectsInserted: 0,
    projectsSkipped: 0,
    sessionsInserted: 0,
    errors: [],
  };

  // ── Load source file ──────────────────────────────────────────────────────
  if (!existsSync(registryPath)) {
    result.errors.push(`Registry file not found: ${registryPath}`);
    return result;
  }

  let registry: Array<{ encodedDir: string; entry: RegistryEntry }>;
  try {
    const raw = readFileSync(registryPath, "utf8");
    registry = parseRegistryEntries(JSON.parse(raw));
  } catch (err) {
    result.errors.push(`Failed to parse registry JSON: ${String(err)}`);
    return result;
  }

  const now = Date.now();

  // ── Build authoritative encoded-dir → path lookup ─────────────────────────
  const lookupMap = buildEncodedDirMap(registryPath);

  // ── Process each encoded directory entry ──────────────────────────────────
  for (const { encodedDir, entry } of registry) {
    const rootPath = decodeEncodedDir(encodedDir, lookupMap);
    const baseSlug = slugify(rootPath) || fallbackSlug(rootPath);

    // --- Upsert project ---
    const { id: projectId, created } = await backend.createProjectWithSlugRetry({
      baseSlug,
      displayName:
        (entry.displayName as string | undefined) ??
        (rootPath.split("/").pop() ?? rootPath),
      rootPath,
      encodedDir,
      createdAt: now,
      updatedAt: now,
    });
    if (created) result.projectsInserted++;
    else result.projectsSkipped++;

    // --- Scan Notes/ directory for session notes ---
    const notesDir =
      typeof entry.notesDir === "string"
        ? entry.notesDir
        : join(rootPath, "Notes");

    if (!existsSync(notesDir)) {
      // No notes directory — that is fine, project still gets created
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(notesDir);
    } catch (err) {
      result.errors.push(
        `Cannot read notes dir ${notesDir}: ${String(err)}`
      );
      continue;
    }

    for (const filename of files) {
      if (!filename.endsWith(".md")) continue;

      const parsed = parseSessionFilename(filename);
      if (!parsed) continue;

      try {
        const inserted = await backend.upsertSessionIfAbsent({
          projectId,
          number: parsed.number,
          date: parsed.date,
          slug: parsed.slug,
          title: parsed.title,
          filename: parsed.filename,
          createdAt: now,
        });
        if (inserted) result.sessionsInserted++;
      } catch (err) {
        result.errors.push(
          `Failed to insert session ${filename}: ${String(err)}`
        );
      }
    }
  }

  return result;
}
