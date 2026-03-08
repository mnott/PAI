/** Registry command registration and simple sub-commands (stats, rebuild, lookup). */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { ok, warn, err, dim, bold, fmtDate } from "../../utils.js";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cmdScan, loadScanConfig, saveScanConfig, resolveHome } from "./scan.js";
import { cmdMigrate } from "./migrate.js";

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function cmdStats(db: Database): void {
  const totalProjects = (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
  const activeProjects = (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'active'").get() as { n: number }).n;
  const archivedProjects = (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'archived'").get() as { n: number }).n;
  const totalSessions = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  const totalTags = (db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n;

  const lastProject = db
    .prepare("SELECT updated_at FROM projects ORDER BY updated_at DESC LIMIT 1")
    .get() as { updated_at: number } | undefined;

  const lastSession = db
    .prepare("SELECT created_at FROM sessions ORDER BY created_at DESC LIMIT 1")
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
    console.log(`  ${bold("Last updated:")} ${fmtDate(lastProject.updated_at)}`);
  }
  if (lastSession) {
    console.log(`  ${bold("Last session:")} ${fmtDate(lastSession.created_at)}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

function cmdRebuild(db: Database): void {
  console.log(warn("Rebuilding registry — all existing data will be erased."));
  console.log(dim("Clearing all tables ..."));

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
// lookup
// ---------------------------------------------------------------------------

function cmdLookup(db: Database, fsPath: string): void {
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
    .description("Walk ~/.claude/projects/ and configured scan_dirs, upsert all projects")
    .option("--add-dir <path>", "Add a directory to scan_dirs config")
    .option("--remove-dir <path>", "Remove a directory from scan_dirs config")
    .option("--show-dirs", "Show currently configured scan directories")
    .action((opts: { addDir?: string; removeDir?: string; showDirs?: boolean }) => {
      if (opts.showDirs) {
        const config = loadScanConfig();
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
        const config = loadScanConfig();
        const resolved = resolveHome(opts.addDir);
        if (!existsSync(resolved)) {
          console.error(err(`Directory not found: ${resolved}`));
          process.exit(1);
        }
        const display = resolved.startsWith(homedir())
          ? "~" + resolved.slice(homedir().length)
          : resolved;
        if (config.scan_dirs.includes(display) || config.scan_dirs.includes(resolved)) {
          console.log(warn(`Already configured: ${display}`));
        } else {
          config.scan_dirs.push(display);
          saveScanConfig(config);
          console.log(ok(`Added scan directory: ${bold(display)}`));
        }
      }
      if (opts.removeDir) {
        const config = loadScanConfig();
        const resolved = resolveHome(opts.removeDir);
        const display = resolved.startsWith(homedir())
          ? "~" + resolved.slice(homedir().length)
          : resolved;
        const before = config.scan_dirs.length;
        config.scan_dirs = config.scan_dirs.filter((d) => resolveHome(d) !== resolved);
        if (config.scan_dirs.length < before) {
          saveScanConfig(config);
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
    .description("Erase all registry data and rebuild from the filesystem (destructive)")
    .action(() => {
      cmdRebuild(getDb());
    });

  // pai registry lookup --path <path>
  registryCmd
    .command("lookup")
    .description("Find the project slug for a filesystem path (for use in scripts)")
    .requiredOption("--path <path>", "Filesystem path to look up")
    .action((opts: { path: string }) => {
      cmdLookup(getDb(), opts.path);
    });
}
