/** Registry command registration and simple sub-commands (stats, rebuild, lookup). */

import type { Command } from "commander";
import { ok, warn, err, dim, bold, fmtDate } from "../../utils.js";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cmdScan, loadScanConfig, saveScanConfig, resolveHome } from "./scan.js";
import { cmdMigrate } from "./migrate.js";
import { cmdDedupe } from "./dedupe.js";
import { cmdReconnect } from "./reconnect.js";
import { legacyDbDisplayPaths } from "../../../storage/sqlite/legacy-migration.js";
import { getRegistryBackend } from "../../../storage/factory.js";
import type { RegistryBackend } from "../../../storage/registry-interface.js";

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

async function cmdStats(): Promise<void> {
  const backend = await getRegistryBackend();
  const totalProjects = await backend.countProjects();
  const activeProjects = await backend.countProjects({ status: "active" });
  const archivedProjects = await backend.countProjects({ status: "archived" });
  const totalSessions = await backend.countSessions();
  const totalTags = (await backend.listAllTags()).length;

  const lastProjectUpdatedAt = await backend.getMostRecentProjectUpdatedAt();
  const lastSessionCreatedAt = await backend.getMostRecentSessionCreatedAt();

  console.log();
  console.log(bold("  PAI Registry Stats"));
  console.log();
  console.log(`  ${bold("Projects:")}     ${totalProjects}`);
  console.log(`  ${bold("  Active:")}     ${activeProjects}`);
  console.log(`  ${bold("  Archived:")}   ${archivedProjects}`);
  console.log(`  ${bold("Sessions:")}     ${totalSessions}`);
  console.log(`  ${bold("Tags:")}         ${totalTags}`);
  if (lastProjectUpdatedAt) {
    console.log(`  ${bold("Last updated:")} ${fmtDate(lastProjectUpdatedAt)}`);
  }
  if (lastSessionCreatedAt) {
    console.log(`  ${bold("Last session:")} ${fmtDate(lastSessionCreatedAt)}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

async function cmdRebuild(backend: RegistryBackend): Promise<void> {
  console.log(warn("Rebuilding registry — all existing data will be erased."));
  console.log(dim("Clearing all tables ..."));

  await backend.resetRegistry();

  console.log(dim("Registry cleared. Re-scanning ..."));
  await cmdScan();
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

async function cmdLookup(fsPath: string): Promise<void> {
  const backend = await getRegistryBackend();
  const resolved = resolve(fsPath);

  const row = await backend.getProjectByRootPath(resolved);

  if (!row) {
    process.exitCode = 1;
    return;
  }

  process.stdout.write(row.slug + "\n");
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerRegistryCommands(registryCmd: Command): void {
  // pai registry scan
  registryCmd
    .command("scan")
    .description("Walk ~/.claude/projects/ and configured scan_dirs, upsert all projects")
    .option("--add-dir <path>", "Add a directory to scan_dirs config")
    .option("--remove-dir <path>", "Remove a directory from scan_dirs config")
    .option("--show-dirs", "Show currently configured scan directories")
    .option("--quick", "Minimal output mode (used by hooks and daemon)")
    .action(async (opts: { addDir?: string; removeDir?: string; showDirs?: boolean; quick?: boolean }) => {
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
          process.exitCode = 1;
          return;
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
        await cmdScan({ quick: opts.quick });
      }
    });

  // pai registry migrate
  registryCmd
    .command("migrate")
    .description("Import data from ~/.claude/session-registry.json")
    .action(async () => {
      await cmdMigrate();
    });

  // pai registry stats
  registryCmd
    .command("stats")
    .description("Show summary statistics for the registry")
    .action(async () => {
      await cmdStats();
    });

  // pai registry rebuild
  registryCmd
    .command("rebuild")
    .description("Erase all registry data and rebuild from the filesystem (destructive)")
    .action(async () => {
      await cmdRebuild(await getRegistryBackend());
    });

  // pai registry dedupe [--execute]
  registryCmd
    .command("dedupe")
    .description(
      "Merge registry rows that describe the same project.\n" +
        "Two spellings of one directory (e.g. via a symlinked path prefix) register\n" +
        "as separate projects and split session history between them. Rows are grouped\n" +
        "by resolved path, so a merge only happens when the paths are provably identical.\n" +
        "Dry-run by default; --execute backs up the registry first and merges in one transaction."
    )
    .option("--execute", "Actually perform the merge (default is dry-run)")
    .action(async (opts: { execute?: boolean }) => {
      await cmdDedupe({
        execute: opts.execute,
        dbPath: legacyDbDisplayPaths().registryDb,
      });
    });

  // pai registry reconnect
  registryCmd
    .command("reconnect")
    .description(
      "Point projects back at the transcripts they lost.\n" +
        "A project's encoded_dir is written once and never updated when the project\n" +
        "moves, so handovers, session digests and checkpoints silently find nothing.\n" +
        "Repairs are read from the transcripts themselves — each records the cwd it ran\n" +
        "in — rather than re-derived from the naming rule that broke.\n" +
        "Dry-run by default; --execute writes the corrected rows in one transaction."
    )
    .option("--execute", "Actually write the corrections (default is dry-run)")
    .action(async (opts: { execute?: boolean }) => {
      await cmdReconnect({ execute: opts.execute });
    });

  // pai registry lookup --path <path>
  registryCmd
    .command("lookup")
    .description("Find the project slug for a filesystem path (for use in scripts)")
    .requiredOption("--path <path>", "Filesystem path to look up")
    .action(async (opts: { path: string }) => {
      await cmdLookup(opts.path);
    });
}
