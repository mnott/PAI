/** Registry scan command: walk ~/.claude/projects/ and populate the registry. */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { ok, warn, err, dim, bold } from "../../utils.js";
import { encodeDir } from "../../utils.js";
import { decodeEncodedDir, slugify, parseSessionFilename, buildEncodedDirMap } from "../../../registry/migrate.js";
import { ensurePaiMarker, discoverPaiMarkers } from "../../../registry/pai-marker.js";
import { upsertProject, upsertSession } from "./utils.js";
import type { Database } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const PAI_CONFIG_DIR = join(homedir(), ".pai");
const PAI_CONFIG_FILE = join(PAI_CONFIG_DIR, "config.json");

interface PaiConfig {
  scan_dirs: string[];
}

export function loadScanConfig(): PaiConfig {
  if (!existsSync(PAI_CONFIG_FILE)) return { scan_dirs: [] };
  try {
    return JSON.parse(readFileSync(PAI_CONFIG_FILE, "utf8")) as PaiConfig;
  } catch {
    return { scan_dirs: [] };
  }
}

export function saveScanConfig(config: PaiConfig): void {
  mkdirSync(PAI_CONFIG_DIR, { recursive: true });
  writeFileSync(PAI_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function resolveHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Recursively find all .md files in a directory, including YYYY/MM subdirectories.
 * Returns filenames (basename only).
 */
export function findNoteFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(entry.name);
    } else if (entry.isDirectory() && /^\d{4}$/.test(entry.name)) {
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
// Scan result type
// ---------------------------------------------------------------------------

export interface ScanResult {
  projectsScanned: number;
  projectsNew: number;
  projectsUpdated: number;
  sessionsScanned: number;
  sessionsNew: number;
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Core scan logic
// ---------------------------------------------------------------------------

export function performScan(db: Database): ScanResult {
  const result: ScanResult = {
    projectsScanned: 0,
    projectsNew: 0,
    projectsUpdated: 0,
    sessionsScanned: 0,
    sessionsNew: 0,
    skipped: [],
  };

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    throw new Error(`Claude projects directory not found: ${CLAUDE_PROJECTS_DIR}`);
  }

  const entries = readdirSync(CLAUDE_PROJECTS_DIR).filter((name) => {
    const full = join(CLAUDE_PROJECTS_DIR, name);
    return statSync(full).isDirectory();
  });

  const lookupMap = buildEncodedDirMap();

  for (const encodedDir of entries) {
    const rootPath = decodeEncodedDir(encodedDir, lookupMap);

    if (!existsSync(rootPath)) {
      result.skipped.push(`${encodedDir} (decoded: ${rootPath} — path not found on disk)`);
      result.projectsScanned++;
      continue;
    }

    const slug = slugify(basename(rootPath) || encodedDir);
    const { id, isNew } = upsertProject(db, slug, rootPath, encodedDir);

    result.projectsScanned++;
    if (isNew) result.projectsNew++;
    else result.projectsUpdated++;

    try {
      ensurePaiMarker(rootPath, slug);
    } catch {
      // Non-fatal
    }

    const claudeNotesDir = join(CLAUDE_PROJECTS_DIR, encodedDir, "Notes");

    if (existsSync(claudeNotesDir)) {
      const rootNotesDir = join(rootPath, "Notes");
      if (claudeNotesDir !== rootNotesDir) {
        db.prepare(
          "UPDATE projects SET claude_notes_dir = ?, updated_at = ? WHERE id = ?"
        ).run(claudeNotesDir, Date.now(), id);
      }
    }

    if (!existsSync(claudeNotesDir)) continue;

    const noteFiles = findNoteFiles(claudeNotesDir);

    for (const filename of noteFiles) {
      const parsed = parseSessionFilename(filename);
      if (!parsed) continue;

      result.sessionsScanned++;
      const isNewSession = upsertSession(db, id, parsed.number, parsed.date, parsed.slug, parsed.title, parsed.filename);
      if (isNewSession) result.sessionsNew++;
    }
  }

  // Phase 2: Scan project-root Notes/ for all registered active projects
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
        const isNewSession = upsertSession(db, project.id, parsed.number, parsed.date, parsed.slug, parsed.title, parsed.filename);
        if (isNewSession) result.sessionsNew++;
      }
    }
  }

  // Phase 3: Scan extra directories from config
  const config = loadScanConfig();
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

        const existing = db
          .prepare("SELECT id FROM projects WHERE root_path = ?")
          .get(childPath) as { id: number } | undefined;

        if (existing) {
          result.projectsScanned++;
          result.projectsUpdated++;

          try { ensurePaiMarker(childPath, childSlug); } catch { /* non-fatal */ }

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

        try { ensurePaiMarker(childPath, childSlug); } catch { /* non-fatal */ }

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

  // Phase 4: Discover PAI.md markers in scan_dirs
  if (config.scan_dirs.length) {
    const resolvedScanDirs = config.scan_dirs.map(resolveHome).filter(existsSync);
    const markers = discoverPaiMarkers(resolvedScanDirs);

    for (const marker of markers) {
      const registeredRow = db
        .prepare("SELECT id, root_path, slug FROM projects WHERE slug = ?")
        .get(marker.slug) as { id: number; root_path: string; slug: string } | undefined;

      if (!registeredRow) continue;

      if (registeredRow.root_path !== marker.projectRoot) {
        const newEncoded = encodeDir(marker.projectRoot);
        const now4 = Date.now();

        const encodedOwner = db
          .prepare("SELECT id FROM projects WHERE encoded_dir = ?")
          .get(newEncoded) as { id: number } | undefined;
        const pathOwner = db
          .prepare("SELECT id FROM projects WHERE root_path = ?")
          .get(marker.projectRoot) as { id: number } | undefined;

        const encodedSafe = !encodedOwner || encodedOwner.id === registeredRow.id;
        const pathSafe = !pathOwner || pathOwner.id === registeredRow.id;

        if (encodedSafe && pathSafe) {
          db.prepare(
            "UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?"
          ).run(marker.projectRoot, newEncoded, now4, registeredRow.id);
        } else if (pathSafe) {
          db.prepare(
            "UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?"
          ).run(marker.projectRoot, now4, registeredRow.id);
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// cmdScan
// ---------------------------------------------------------------------------

export function cmdScan(db: Database): void {
  const config = loadScanConfig();
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
    ok(`Scanned ${bold(String(result.projectsScanned))} projects, ${bold(String(result.sessionsScanned))} session notes.`)
  );
  console.log(dim(`  Projects: ${result.projectsNew} new, ${result.projectsUpdated} updated`));
  console.log(dim(`  Sessions: ${result.sessionsNew} new`));

  if (result.skipped.length) {
    console.log();
    console.log(warn(`  ${result.skipped.length} project(s) skipped (path not found on disk):`));
    for (const s of result.skipped.slice(0, 10)) {
      console.log(dim(`    ${s}`));
    }
    if (result.skipped.length > 10) {
      console.log(dim(`    ... and ${result.skipped.length - 10} more`));
    }
  }
}
