/** Registry migrate command: import data from ~/.claude/session-registry.json. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ok, warn, err, dim } from "../../utils.js";
import { slugify, parseSessionFilename } from "../../../registry/migrate.js";
import { upsertProject, upsertSession } from "./utils.js";
import { getRegistryBackend } from "../../../storage/factory.js";

// ---------------------------------------------------------------------------
// Legacy JSON registry types
// ---------------------------------------------------------------------------

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

const SESSION_REGISTRY_PATH = join(homedir(), ".claude", "session-registry.json");

// ---------------------------------------------------------------------------
// cmdMigrate
// ---------------------------------------------------------------------------

export async function cmdMigrate(): Promise<void> {
  if (!existsSync(SESSION_REGISTRY_PATH)) {
    console.error(err(`session-registry.json not found: ${SESSION_REGISTRY_PATH}`));
    process.exitCode = 1;
    return;
  }

  let registry: LegacyJsonRegistry;
  try {
    const raw = readFileSync(SESSION_REGISTRY_PATH, "utf8");
    registry = JSON.parse(raw) as LegacyJsonRegistry;
  } catch (e) {
    console.error(err(`Failed to parse session-registry.json: ${e}`));
    process.exitCode = 1;
    return;
  }

  const projects = registry.projects ?? [];
  if (!projects.length) {
    console.log(warn("No projects found in session-registry.json."));
    return;
  }

  console.log(dim(`Migrating ${projects.length} project(s) from session-registry.json ...`));

  const backend = await getRegistryBackend();
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
      const { isNew, id } = await upsertProject(backend, slug, rootPath, encodedDir);
      if (isNew) projectsNew++;
      else projectsSkipped++;

      const notes = entry.notes ?? [];
      for (const filename of notes) {
        const parsed = parseSessionFilename(filename);
        if (!parsed) continue;

        const isNewSession = await upsertSession(backend, id, parsed.number, parsed.date, parsed.slug, parsed.title, parsed.filename);
        if (isNewSession) sessionsNew++;
      }
    } catch (e) {
      errors.push(`Error processing ${entry.encoded_dir}: ${String(e)}`);
    }
  }

  console.log(ok("Migration complete."));
  console.log(dim(`  Projects: ${projectsNew} new, ${projectsSkipped} already existed`));
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
