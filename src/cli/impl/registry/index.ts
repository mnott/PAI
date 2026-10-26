/** Registry command implementation without a parser dependency. */

import { ok, warn, err, dim, bold, fmtDate } from "../../lib/utils.js";
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

export async function registryStatsCmd(): Promise<number> {
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
  return 0;
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

export async function registryRebuildCmd(opts: { yes?: boolean } = {}): Promise<number> {
  const backend = await getRegistryBackend();
  if (!opts.yes) {
    const orphans = await backend.countOrphanedChunks();
    console.log(warn("Rebuilding the registry would delete:"));
    console.log(`  ${await backend.countProjects()} projects, ${await backend.countSessions()} sessions, all tags, aliases and links`);
    console.log(dim(`  (every project gets a new id; ${orphans.total} indexed chunks would be orphaned unless ids are reused)`));
    console.log(dim("  A backup of the projects table is kept. Re-run with --yes to do it."));
    return 1;
  }
  console.log(warn("Rebuilding registry — all existing data will be erased."));
  console.log(dim("Clearing all tables ..."));

  const { backupTable } = await backend.resetRegistry();
  if (backupTable) console.log(dim(`Projects backed up to ${backupTable}`));

  console.log(dim("Registry cleared. Re-scanning ..."));
  await cmdScan();
  return 0;
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

export async function registryLookupCmd(fsPath: string): Promise<number> {
  const backend = await getRegistryBackend();
  const resolved = resolve(fsPath);

  const row = await backend.getProjectByRootPath(resolved);

  if (!row) {
    return 1;
  }

  process.stdout.write(row.slug + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

export async function registryScanCmd(opts: {
  addDir?: string;
  removeDir?: string;
  showDirs?: boolean;
  quick?: boolean;
  filterReport?: boolean;
  pruneEphemeral?: boolean;
}): Promise<number> {
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
    return 0;
  }
  if (opts.addDir) {
    const config = loadScanConfig();
    const resolved = resolveHome(opts.addDir);
    if (!existsSync(resolved)) {
      console.error(err(`Directory not found: ${resolved}`));
      return 1;
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
    return 0;
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
    return 0;
  }
  if (opts.pruneEphemeral) {
    const { planEphemeralPrune } = await import("../../../registry/registrable.js");
    const backend = await getRegistryBackend();
    const plan = await planEphemeralPrune(backend);
    console.log(`Removing ${plan.remove.length} registry row(s) (directories on disk untouched). First 10:`);
    for (const r of plan.remove.slice(0, 10)) console.log(`  ${r.slug}  ${r.root_path}`);
    for (const r of plan.remove) await backend.deleteProjectCascade(r.id);
    console.log(`Kept ${plan.kept.length} matching row(s) (sessions > 0 or curated name):`);
    for (const k of plan.kept) console.log(`  ${k.slug}  ${k.root_path}  sessions=${k.sessions}${k.curated ? " curated" : ""}`);
    return 0;
  }
  if (opts.filterReport) {
    const { reportUnregistrable } = await import("../../../registry/registrable.js");
    const r = await reportUnregistrable(await getRegistryBackend());
    console.log(`Registry rows: ${r.total}`);
    console.log(`  matching the registration filter: ${r.matching} (${r.matchingMissing} with a missing path)`);
    for (const [why, n] of Object.entries(r.byReason)) console.log(`    ${n}  ${why}`);
    for (const p of r.sample) console.log(dim(`    e.g. ${p}`));
    console.log(dim("  Dry run: nothing deleted. Cleanup is a separate, operator-approved step."));
    return 0;
  }
  if (!opts.addDir && !opts.removeDir) {
    await cmdScan({ quick: opts.quick });
  }
  return 0;
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

export async function registryMigrateCmd(): Promise<number> {
  await cmdMigrate();
  return 0;
}

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

export async function registryDedupeCmd(opts: { execute?: boolean }): Promise<number> {
  await cmdDedupe({
    execute: opts.execute,
    dbPath: legacyDbDisplayPaths().registryDb,
  });
  return 0;
}

// ---------------------------------------------------------------------------
// reconnect
// ---------------------------------------------------------------------------

export async function registryReconnectCmd(opts: { execute?: boolean }): Promise<number> {
  await cmdReconnect({ execute: opts.execute });
  return 0;
}