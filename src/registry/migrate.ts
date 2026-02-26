/**
 * Migration helper: imports the existing JSON session-registry into the
 * new SQLite registry.db.
 *
 * Source file:  ~/.claude/session-registry.json
 * Target:       openRegistry() → projects + sessions tables
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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";

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

/** Top-level shape of session-registry.json */
type SessionRegistry = Record<string, RegistryEntry>;

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

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
  jsonPath: string = join(homedir(), ".claude", "session-registry.json")
): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(jsonPath)) return map;

  try {
    const raw = readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Support both formats:
    //   list-based:   { "projects": [ { "encoded_dir", "original_path" }, ... ] }
    //   object-keyed: { "<encoded_dir>": { ... } }  (original Claude format)
    if (Array.isArray(parsed.projects)) {
      for (const entry of parsed.projects as Array<Record<string, unknown>>) {
        const key = entry.encoded_dir as string | undefined;
        const val = entry.original_path as string | undefined;
        if (key && val) map.set(key, val);
      }
    } else {
      // Object-keyed format — keys are encoded dirs
      for (const [key, value] of Object.entries(parsed)) {
        if (key === "version") continue;
        const val = (value as Record<string, unknown>)?.original_path as
          | string
          | undefined;
        if (val) map.set(key, val);
      }
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
  // Authoritative lookup wins
  if (lookupMap?.has(encoded)) {
    return lookupMap.get(encoded)!;
  }

  // Best-effort heuristic: every `-` maps to `/`.
  // This is correct for simple paths (no spaces, dots, or literal hyphens
  // in component names) but will produce wrong results for e.g. `.ssh`
  // (decoded as `/ssh` instead of `/.ssh`).  That's acceptable here because
  // callers should be using the lookupMap for paths that exist in the registry.
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
 * Migrate the existing JSON session-registry into the SQLite registry.
 *
 * @param db            Open better-sqlite3 Database (target).
 * @param registryPath  Path to session-registry.json.
 *                      Defaults to ~/.claude/session-registry.json.
 *
 * The migration is idempotent: projects and sessions that already exist
 * (matched by slug / project_id+number) are silently skipped.
 */
export function migrateFromJson(
  db: Database,
  registryPath: string = join(homedir(), ".claude", "session-registry.json")
): MigrationResult {
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

  let registry: SessionRegistry;
  try {
    const raw = readFileSync(registryPath, "utf8");
    registry = JSON.parse(raw) as SessionRegistry;
  } catch (err) {
    result.errors.push(`Failed to parse registry JSON: ${String(err)}`);
    return result;
  }

  // ── Prepared statements ───────────────────────────────────────────────────
  const insertProject = db.prepare(`
    INSERT OR IGNORE INTO projects
      (slug, display_name, root_path, encoded_dir, type, status,
       created_at, updated_at)
    VALUES
      (@slug, @display_name, @root_path, @encoded_dir, 'local', 'active',
       @created_at, @updated_at)
  `);

  const getProject = db.prepare(
    "SELECT id FROM projects WHERE slug = ?"
  );

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions
      (project_id, number, date, slug, title, filename, status, created_at)
    VALUES
      (@project_id, @number, @date, @slug, @title, @filename, 'completed',
       @created_at)
  `);

  const now = Date.now();

  // ── Build authoritative encoded-dir → path lookup ─────────────────────────
  const lookupMap = buildEncodedDirMap(registryPath);

  // ── Process each encoded directory entry ──────────────────────────────────
  for (const [encodedDir, entry] of Object.entries(registry)) {
    const rootPath = decodeEncodedDir(encodedDir, lookupMap);
    const baseSlug = slugify(rootPath);

    // --- Upsert project ---
    let slug = baseSlug;
    let attempt = 0;
    while (true) {
      const info = insertProject.run({
        slug,
        display_name:
          (entry.displayName as string | undefined) ??
          (rootPath.split("/").pop() ?? rootPath),
        root_path: rootPath,
        encoded_dir: encodedDir,
        created_at: now,
        updated_at: now,
      });

      if (info.changes > 0) {
        result.projectsInserted++;
        break;
      }

      // Row existed — check if it's ours (matching root_path) or a collision
      const existing = db
        .prepare("SELECT id FROM projects WHERE root_path = ?")
        .get(rootPath);
      if (existing) {
        result.projectsSkipped++;
        break;
      }

      // Genuine slug collision — append numeric suffix and retry
      attempt++;
      slug = `${baseSlug}-${attempt}`;
    }

    const projectRow = getProject.get(slug) as { id: number } | undefined;
    // Also check by root_path in case slug was different
    const projectById = projectRow ??
      (db
        .prepare("SELECT id FROM projects WHERE root_path = ?")
        .get(rootPath) as { id: number } | undefined);

    if (!projectById) {
      result.errors.push(
        `Could not resolve project id for encoded dir: ${encodedDir}`
      );
      continue;
    }

    const projectId = projectById.id;

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
        const info = insertSession.run({
          project_id: projectId,
          number: parsed.number,
          date: parsed.date,
          slug: parsed.slug,
          title: parsed.title,
          filename: parsed.filename,
          created_at: now,
        });
        if (info.changes > 0) result.sessionsInserted++;
      } catch (err) {
        result.errors.push(
          `Failed to insert session ${filename}: ${String(err)}`
        );
      }
    }
  }

  return result;
}
