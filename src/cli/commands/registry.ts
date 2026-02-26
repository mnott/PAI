/**
 * pai registry <sub-command>
 *
 * scan     — walk ~/.claude/projects/ and populate the registry
 * migrate  — import from ~/.claude/session-registry.json
 * stats    — quick summary counts
 * rebuild  — drop all data and rescan from filesystem
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import {
  ok,
  warn,
  err,
  dim,
  bold,
  fmtDate,
  now,
} from "../utils.js";
import { decodeEncodedDir, slugify, parseSessionFilename, buildEncodedDirMap } from "../../registry/migrate.js";
import { ensurePaiMarker, discoverPaiMarkers } from "../../registry/pai-marker.js";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { encodeDir } from "../utils.js";

/**
 * Recursively find all .md files in a directory, including YYYY/MM subdirectories
 * created by session cleanup. Returns filenames (basename only).
 */
function findNoteFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(entry.name);
    } else if (entry.isDirectory() && /^\d{4}$/.test(entry.name)) {
      // Year directory (e.g. 2026/) — recurse into month dirs
      const yearDir = join(dir, entry.name);
      for (const monthEntry of readdirSync(yearDir, { withFileTypes: true })) {
        if (monthEntry.isDirectory() && /^\d{2}$/.test(monthEntry.name)) {
          const monthDir = join(yearDir, monthEntry.name);
          for (const noteEntry of readdirSync(monthDir, { withFileTypes: true })) {
            if (noteEntry.isFile() && noteEntry.name.endsWith(".md")) {
              results.push(noteEntry.name);
            }
          }
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Constants & config
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const PAI_CONFIG_DIR = join(homedir(), ".pai");
const PAI_CONFIG_FILE = join(PAI_CONFIG_DIR, "config.json");

interface PaiConfig {
  scan_dirs: string[];
}

function loadConfig(): PaiConfig {
  if (!existsSync(PAI_CONFIG_FILE)) return { scan_dirs: [] };
  try {
    return JSON.parse(readFileSync(PAI_CONFIG_FILE, "utf8")) as PaiConfig;
  } catch {
    return { scan_dirs: [] };
  }
}

function saveConfig(config: PaiConfig): void {
  mkdirSync(PAI_CONFIG_DIR, { recursive: true });
  writeFileSync(PAI_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function resolveHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a project row.  Returns { id, isNew }.
 *
 * Matching priority:
 *  1. root_path  — most reliable; handles slug collisions
 *  2. encoded_dir — Claude project dirs are canonical
 *  3. Insert with suffix-deduplication on slug collision
 */
function upsertProject(
  db: Database,
  slug: string,
  rootPath: string,
  encodedDir: string
): { id: number; isNew: boolean } {
  // 1. Match by root_path
  const byPath = db
    .prepare("SELECT id FROM projects WHERE root_path = ?")
    .get(rootPath) as { id: number } | undefined;

  if (byPath) {
    db.prepare(
      "UPDATE projects SET encoded_dir = ?, updated_at = ? WHERE id = ?"
    ).run(encodedDir, now(), byPath.id);
    return { id: byPath.id, isNew: false };
  }

  // 2. Match by encoded_dir (same Claude project dir, different root_path record)
  const byEncoded = db
    .prepare("SELECT id FROM projects WHERE encoded_dir = ?")
    .get(encodedDir) as { id: number } | undefined;

  if (byEncoded) {
    db.prepare(
      "UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?"
    ).run(rootPath, now(), byEncoded.id);
    return { id: byEncoded.id, isNew: false };
  }

  // 3. Insert — deduplicate slug with numeric suffix if needed
  let finalSlug = slug;
  let attempt = 0;
  while (true) {
    const conflict = db
      .prepare("SELECT id FROM projects WHERE slug = ?")
      .get(finalSlug) as { id: number } | undefined;
    if (!conflict) break;
    attempt++;
    finalSlug = `${slug}-${attempt}`;
  }

  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO projects
         (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`
    )
    .run(finalSlug, finalSlug, rootPath, encodedDir, ts, ts);

  return { id: result.lastInsertRowid as number, isNew: true };
}

/**
 * Upsert a session note.  Returns true if newly inserted.
 */
function upsertSession(
  db: Database,
  projectId: number,
  number: number,
  date: string,
  slug: string,
  title: string,
  filename: string
): boolean {
  const existing = db
    .prepare("SELECT id FROM sessions WHERE project_id = ? AND number = ?")
    .get(projectId, number);

  if (existing) return false;

  const ts = now();
  db.prepare(
    `INSERT INTO sessions
       (project_id, number, date, slug, title, filename, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`
  ).run(projectId, number, date, slug, title, filename, ts);

  return true;
}

// ---------------------------------------------------------------------------
// Scan command
// ---------------------------------------------------------------------------

interface ScanResult {
  projectsScanned: number;
  projectsNew: number;
  projectsUpdated: number;
  sessionsScanned: number;
  sessionsNew: number;
  skipped: string[];
}

function performScan(db: Database): ScanResult {
  const result: ScanResult = {
    projectsScanned: 0,
    projectsNew: 0,
    projectsUpdated: 0,
    sessionsScanned: 0,
    sessionsNew: 0,
    skipped: [],
  };

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    throw new Error(
      `Claude projects directory not found: ${CLAUDE_PROJECTS_DIR}`
    );
  }

  const entries = readdirSync(CLAUDE_PROJECTS_DIR).filter((name) => {
    const full = join(CLAUDE_PROJECTS_DIR, name);
    return statSync(full).isDirectory();
  });

  // Build authoritative encoded-dir → original_path lookup from session-registry.json
  // so that decodeEncodedDir uses real paths (the encoding is lossy and ambiguous).
  const lookupMap = buildEncodedDirMap();

  for (const encodedDir of entries) {
    // Decode the Claude-encoded directory name back to an absolute path.
    // Uses the authoritative lookup map first, falling back to heuristic decode.
    const rootPath = decodeEncodedDir(encodedDir, lookupMap);

    if (!existsSync(rootPath)) {
      result.skipped.push(
        `${encodedDir} (decoded: ${rootPath} — path not found on disk)`
      );
      result.projectsScanned++;
      continue;
    }

    const slug = slugify(basename(rootPath) || encodedDir);
    const { id, isNew } = upsertProject(db, slug, rootPath, encodedDir);

    result.projectsScanned++;
    if (isNew) result.projectsNew++;
    else result.projectsUpdated++;

    // Ensure PAI.md marker exists (or is up-to-date) for this project.
    try {
      ensurePaiMarker(rootPath, slug);
    } catch {
      // Non-fatal — marker creation failure should not abort the scan.
    }

    // Scan the Notes/ subdirectory inside the Claude project dir
    const claudeNotesDir = join(CLAUDE_PROJECTS_DIR, encodedDir, "Notes");

    // Store the Claude notes dir on the project if it exists and differs from
    // {rootPath}/Notes/ — this lets the indexer find notes that live only
    // inside ~/.claude/projects/{encoded}/Notes/.
    if (existsSync(claudeNotesDir)) {
      const rootNotesDir = join(rootPath, "Notes");
      if (claudeNotesDir !== rootNotesDir) {
        db.prepare(
          "UPDATE projects SET claude_notes_dir = ?, updated_at = ? WHERE id = ?"
        ).run(claudeNotesDir, now(), id);
      }
    }

    if (!existsSync(claudeNotesDir)) continue;

    const noteFiles = findNoteFiles(claudeNotesDir);

    for (const filename of noteFiles) {
      const parsed = parseSessionFilename(filename);
      if (!parsed) continue;

      result.sessionsScanned++;
      const isNewSession = upsertSession(
        db,
        id,
        parsed.number,
        parsed.date,
        parsed.slug,
        parsed.title,
        parsed.filename
      );
      if (isNewSession) result.sessionsNew++;
    }
  }

  // Phase 2: Scan project-root Notes/ for all registered active projects
  // Many projects store their session notes at {root_path}/Notes/ rather than
  // inside ~/.claude/projects/{encoded}/Notes/ — pick those up here.
  {
    const activeProjects = db
      .prepare("SELECT id, slug, root_path FROM projects WHERE status = 'active'")
      .all() as { id: number; slug: string; root_path: string }[];

    for (const project of activeProjects) {
      const notesDir = join(project.root_path, "Notes");
      if (!existsSync(notesDir)) continue;

      let files: string[];
      try {
        files = findNoteFiles(notesDir);
      } catch {
        continue;
      }

      for (const filename of files) {
        const parsed = parseSessionFilename(filename);
        if (!parsed) continue;

        result.sessionsScanned++;
        const isNewSession = upsertSession(
          db,
          project.id,
          parsed.number,
          parsed.date,
          parsed.slug,
          parsed.title,
          parsed.filename
        );
        if (isNewSession) result.sessionsNew++;
      }
    }
  }

  // Phase 3: Scan extra directories from config
  const config = loadConfig();
  if (config.scan_dirs.length) {
    for (const rawDir of config.scan_dirs) {
      const scanDir = resolveHome(rawDir);
      if (!existsSync(scanDir)) {
        result.skipped.push(`${rawDir} (configured scan_dir not found)`);
        continue;
      }

      const children = readdirSync(scanDir).filter((name) => {
        if (name.startsWith(".")) return false;
        const full = join(scanDir, name);
        try { return statSync(full).isDirectory(); } catch { return false; }
      });

      for (const child of children) {
        const childPath = join(scanDir, child);
        const childSlug = slugify(child);
        const childEncoded = encodeDir(childPath);

        // Skip if already registered by path
        const existing = db
          .prepare("SELECT id FROM projects WHERE root_path = ?")
          .get(childPath) as { id: number } | undefined;

        if (existing) {
          result.projectsScanned++;
          result.projectsUpdated++;

          // Ensure PAI.md marker exists for already-registered project.
          try { ensurePaiMarker(childPath, childSlug); } catch { /* non-fatal */ }

          // Still scan Notes/ for new sessions
          const notesDir = join(childPath, "Notes");
          if (existsSync(notesDir)) {
            const noteFiles = readdirSync(notesDir).filter((f) => f.endsWith(".md"));
            for (const filename of noteFiles) {
              const parsed = parseSessionFilename(filename);
              if (!parsed) continue;
              result.sessionsScanned++;
              if (upsertSession(db, existing.id, parsed.number, parsed.date, parsed.slug, parsed.title, parsed.filename)) {
                result.sessionsNew++;
              }
            }
          }
          continue;
        }

        const { id, isNew } = upsertProject(db, childSlug, childPath, childEncoded);
        result.projectsScanned++;
        if (isNew) result.projectsNew++;
        else result.projectsUpdated++;

        // Ensure PAI.md marker exists for newly-registered project.
        try { ensurePaiMarker(childPath, childSlug); } catch { /* non-fatal */ }

        // Scan Notes/ in the project itself (not Claude's project dir)
        const notesDir = join(childPath, "Notes");
        if (existsSync(notesDir)) {
          const noteFiles = readdirSync(notesDir).filter((f) => f.endsWith(".md"));
          for (const filename of noteFiles) {
            const parsed = parseSessionFilename(filename);
            if (!parsed) continue;
            result.sessionsScanned++;
            if (upsertSession(db, id, parsed.number, parsed.date, parsed.slug, parsed.title, parsed.filename)) {
              result.sessionsNew++;
            }
          }
        }
      }
    }
  }

  // Phase 4: Discover PAI.md markers in scan_dirs.
  // This catches relocated projects: if a project moved but still has a
  // Notes/PAI.md with the original slug, we can find it and auto-update.
  if (config.scan_dirs.length) {
    const resolvedScanDirs = config.scan_dirs.map(resolveHome).filter(existsSync);
    const markers = discoverPaiMarkers(resolvedScanDirs);

    for (const marker of markers) {
      // Check if this slug is already registered at the correct path.
      const registeredRow = db
        .prepare("SELECT id, root_path, slug FROM projects WHERE slug = ?")
        .get(marker.slug) as { id: number; root_path: string; slug: string } | undefined;

      if (!registeredRow) continue; // Unknown slug — leave it for normal scan.

      if (registeredRow.root_path !== marker.projectRoot) {
        // The project moved — update the stored path.
        const newEncoded = encodeDir(marker.projectRoot);
        db.prepare(
          "UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?"
        ).run(marker.projectRoot, newEncoded, Date.now(), registeredRow.id);
      }
    }
  }

  return result;
}

function cmdScan(db: Database): void {
  const config = loadConfig();
  console.log(dim("Scanning ~/.claude/projects/ ..."));
  if (config.scan_dirs.length) {
    console.log(dim(`Scanning ${config.scan_dirs.length} extra dir(s): ${config.scan_dirs.join(", ")}`));
  }
  console.log(dim("Scanning project-root Notes/ directories ..."));

  let result: ScanResult;
  try {
    result = performScan(db);
  } catch (e) {
    console.error(err(String(e)));
    process.exit(1);
  }

  console.log(
    ok(
      `Scanned ${bold(String(result.projectsScanned))} projects, ` +
        `${bold(String(result.sessionsScanned))} session notes.`
    )
  );
  console.log(
    dim(
      `  Projects: ${result.projectsNew} new, ${result.projectsUpdated} updated`
    )
  );
  console.log(dim(`  Sessions: ${result.sessionsNew} new`));

  if (result.skipped.length) {
    console.log();
    console.log(
      warn(`  ${result.skipped.length} project(s) skipped (path not found on disk):`)
    );
    for (const s of result.skipped.slice(0, 10)) {
      console.log(dim(`    ${s}`));
    }
    if (result.skipped.length > 10) {
      console.log(dim(`    ... and ${result.skipped.length - 10} more`));
    }
  }
}

// ---------------------------------------------------------------------------
// Migrate command
// ---------------------------------------------------------------------------

/**
 * The actual on-disk session-registry.json format used by this PAI instance:
 *   {
 *     "version": 1,
 *     "projects": [ { "encoded_dir", "original_path", "notes": [...], ... }, ... ],
 *     ...other keys ignored...
 *   }
 *
 * Note: the migrate.ts module in src/registry/ was written for a different
 * object-keyed format.  This function handles the list-based format directly.
 */

interface LegacyProjectEntry {
  encoded_dir: string;
  original_path: string;
  notes?: string[];
  session_count?: number;
  note_count?: number;
  todo_exists?: boolean;
  last_modified?: string;
  path_exists?: boolean;
}

interface LegacyJsonRegistry {
  version?: number;
  projects?: LegacyProjectEntry[];
  [key: string]: unknown;
}

const SESSION_REGISTRY_PATH = join(
  homedir(),
  ".claude",
  "session-registry.json"
);

function cmdMigrate(db: Database): void {
  if (!existsSync(SESSION_REGISTRY_PATH)) {
    console.error(
      err(`session-registry.json not found: ${SESSION_REGISTRY_PATH}`)
    );
    process.exit(1);
  }

  let registry: LegacyJsonRegistry;
  try {
    const raw = readFileSync(SESSION_REGISTRY_PATH, "utf8");
    registry = JSON.parse(raw) as LegacyJsonRegistry;
  } catch (e) {
    console.error(err(`Failed to parse session-registry.json: ${e}`));
    process.exit(1);
  }

  const projects = registry.projects ?? [];
  if (!projects.length) {
    console.log(warn("No projects found in session-registry.json."));
    return;
  }

  console.log(
    dim(
      `Migrating ${projects.length} project(s) from session-registry.json ...`
    )
  );

  let projectsNew = 0;
  let projectsSkipped = 0;
  let sessionsNew = 0;
  const errors: string[] = [];

  for (const entry of projects) {
    if (!entry.original_path || !entry.encoded_dir) {
      errors.push(`Skipping entry with missing path: ${JSON.stringify(entry)}`);
      continue;
    }

    const rootPath = entry.original_path;
    const encodedDir = entry.encoded_dir;
    const slug = slugify(rootPath);

    try {
      const { isNew, id } = upsertProject(db, slug, rootPath, encodedDir);
      if (isNew) projectsNew++;
      else projectsSkipped++;

      // Import session notes from the notes array in the JSON
      const notes = entry.notes ?? [];
      for (const filename of notes) {
        const parsed = parseSessionFilename(filename);
        if (!parsed) continue;

        const isNewSession = upsertSession(
          db,
          id,
          parsed.number,
          parsed.date,
          parsed.slug,
          parsed.title,
          parsed.filename
        );
        if (isNewSession) sessionsNew++;
      }
    } catch (e) {
      errors.push(
        `Error processing ${entry.encoded_dir}: ${String(e)}`
      );
    }
  }

  console.log(ok("Migration complete."));
  console.log(
    dim(
      `  Projects: ${projectsNew} new, ${projectsSkipped} already existed`
    )
  );
  console.log(dim(`  Sessions: ${sessionsNew} new`));

  if (errors.length) {
    console.log();
    console.log(warn(`  ${errors.length} error(s) during migration:`));
    for (const e of errors.slice(0, 5)) {
      console.log(dim(`    ${e}`));
    }
    if (errors.length > 5) {
      console.log(dim(`    ... and ${errors.length - 5} more`));
    }
  }
}

// ---------------------------------------------------------------------------
// Stats command
// ---------------------------------------------------------------------------

function cmdStats(db: Database): void {
  const totalProjects = (
    db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }
  ).n;
  const activeProjects = (
    db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'active'")
      .get() as { n: number }
  ).n;
  const archivedProjects = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM projects WHERE status = 'archived'"
      )
      .get() as { n: number }
  ).n;
  const totalSessions = (
    db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
  ).n;
  const totalTags = (
    db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }
  ).n;

  const lastProject = db
    .prepare("SELECT updated_at FROM projects ORDER BY updated_at DESC LIMIT 1")
    .get() as { updated_at: number } | undefined;

  const lastSession = db
    .prepare(
      "SELECT created_at FROM sessions ORDER BY created_at DESC LIMIT 1"
    )
    .get() as { created_at: number } | undefined;

  console.log();
  console.log(bold("  PAI Registry Stats"));
  console.log();
  console.log(`  ${bold("Projects:")}     ${totalProjects}`);
  console.log(`  ${bold("  Active:")}     ${activeProjects}`);
  console.log(`  ${bold("  Archived:")}   ${archivedProjects}`);
  console.log(`  ${bold("Sessions:")}     ${totalSessions}`);
  console.log(`  ${bold("Tags:")}         ${totalTags}`);
  if (lastProject) {
    console.log(
      `  ${bold("Last updated:")} ${fmtDate(lastProject.updated_at)}`
    );
  }
  if (lastSession) {
    console.log(
      `  ${bold("Last session:")} ${fmtDate(lastSession.created_at)}`
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Rebuild command
// ---------------------------------------------------------------------------

function cmdRebuild(db: Database): void {
  console.log(warn("Rebuilding registry — all existing data will be erased."));
  console.log(dim("Clearing all tables ..."));

  // Delete in dependency order (FK constraints are ON)
  db.exec(`
    DELETE FROM compaction_log;
    DELETE FROM session_tags;
    DELETE FROM project_tags;
    DELETE FROM aliases;
    DELETE FROM sessions;
    DELETE FROM projects;
    DELETE FROM tags;
    DELETE FROM schema_version;
  `);

  console.log(dim("Registry cleared. Re-scanning ..."));
  cmdScan(db);
}

// ---------------------------------------------------------------------------
// Lookup command
// ---------------------------------------------------------------------------

/**
 * Print the project slug whose root_path matches the given filesystem path.
 * Exits 0 on success, 1 if not found.  Output is plain (for use in scripts).
 */
function cmdLookup(db: Database, fsPath: string): void {
  // Resolve to an absolute path so relative inputs still match
  const resolved = resolve(fsPath);

  const row = db
    .prepare("SELECT slug FROM projects WHERE root_path = ?")
    .get(resolved) as { slug: string } | undefined;

  if (!row) {
    process.exit(1);
  }

  process.stdout.write(row.slug + "\n");
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerRegistryCommands(
  registryCmd: Command,
  getDb: () => Database
): void {
  // pai registry scan
  registryCmd
    .command("scan")
    .description(
      "Walk ~/.claude/projects/ and configured scan_dirs, upsert all projects"
    )
    .option("--add-dir <path>", "Add a directory to scan_dirs config (immediate children become projects)")
    .option("--remove-dir <path>", "Remove a directory from scan_dirs config")
    .option("--show-dirs", "Show currently configured scan directories")
    .action((opts: { addDir?: string; removeDir?: string; showDirs?: boolean }) => {
      if (opts.showDirs) {
        const config = loadConfig();
        if (!config.scan_dirs.length) {
          console.log(dim("  No extra scan directories configured."));
          console.log(dim("  Use --add-dir <path> to add one."));
        } else {
          console.log(bold("  Configured scan directories:"));
          for (const d of config.scan_dirs) {
            console.log(`    ${d}`);
          }
        }
        return;
      }
      if (opts.addDir) {
        const config = loadConfig();
        const resolved = resolveHome(opts.addDir);
        if (!existsSync(resolved)) {
          console.error(err(`Directory not found: ${resolved}`));
          process.exit(1);
        }
        // Store with ~ prefix for portability
        const display = resolved.startsWith(homedir())
          ? "~" + resolved.slice(homedir().length)
          : resolved;
        if (config.scan_dirs.includes(display) || config.scan_dirs.includes(resolved)) {
          console.log(warn(`Already configured: ${display}`));
        } else {
          config.scan_dirs.push(display);
          saveConfig(config);
          console.log(ok(`Added scan directory: ${bold(display)}`));
        }
      }
      if (opts.removeDir) {
        const config = loadConfig();
        const resolved = resolveHome(opts.removeDir);
        const display = resolved.startsWith(homedir())
          ? "~" + resolved.slice(homedir().length)
          : resolved;
        const before = config.scan_dirs.length;
        config.scan_dirs = config.scan_dirs.filter(
          (d) => resolveHome(d) !== resolved
        );
        if (config.scan_dirs.length < before) {
          saveConfig(config);
          console.log(ok(`Removed scan directory: ${bold(display)}`));
        } else {
          console.log(warn(`Not found in config: ${display}`));
        }
      }
      if (!opts.addDir && !opts.removeDir) {
        cmdScan(getDb());
      }
    });

  // pai registry migrate
  registryCmd
    .command("migrate")
    .description("Import data from ~/.claude/session-registry.json")
    .action(() => {
      cmdMigrate(getDb());
    });

  // pai registry stats
  registryCmd
    .command("stats")
    .description("Show summary statistics for the registry")
    .action(() => {
      cmdStats(getDb());
    });

  // pai registry rebuild
  registryCmd
    .command("rebuild")
    .description(
      "Erase all registry data and rebuild from the filesystem (destructive)"
    )
    .action(() => {
      cmdRebuild(getDb());
    });

  // pai registry lookup --path <path>
  registryCmd
    .command("lookup")
    .description(
      "Find the project slug for a filesystem path (for use in scripts)"
    )
    .requiredOption("--path <path>", "Filesystem path to look up")
    .action((opts: { path: string }) => {
      cmdLookup(getDb(), opts.path);
    });
}
