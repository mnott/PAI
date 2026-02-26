/**
 * pai obsidian <sub-command>
 *
 * sync    — symlink project Notes/ dirs into vault, write _index.md + _topics/
 * status  — health report: healthy, broken, orphaned, missing symlinks
 * open    — open vault in Obsidian app (macOS)
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { execSync } from "node:child_process";
import { ok, warn, err, dim, bold, header } from "../utils.js";
import {
  syncVault,
  generateIndex,
  generateTopicPages,
  generateMasterNotes,
  fixSessionTags,
  defaultVaultPath,
} from "../../obsidian/sync.js";
import { checkHealth } from "../../obsidian/status.js";
import {
  loadConfig,
  expandHome,
  CONFIG_FILE,
} from "../../daemon/config.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Read obsidianVaultPath from ~/.config/pai/config.json.
 * Falls back to defaultVaultPath() if not set.
 */
function getVaultPath(override?: string): string {
  if (override) return expandHome(override);

  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof cfg.obsidianVaultPath === "string" && cfg.obsidianVaultPath) {
      return expandHome(cfg.obsidianVaultPath);
    }
  } catch {
    // Config missing or unreadable — use default
  }
  return defaultVaultPath();
}

/**
 * Persist obsidianVaultPath into config.json so future syncs use the same path.
 */
function saveVaultPath(vaultPath: string): void {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    // Start fresh if file is missing/corrupt
  }
  cfg.obsidianVaultPath = vaultPath;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function cmdSync(
  db: Database,
  opts: { vault?: string; quiet?: boolean }
): void {
  const vaultPath = getVaultPath(opts.vault);
  const q = opts.quiet ?? false;

  if (!q) {
    console.log();
    console.log(header("  PAI Obsidian Sync"));
    console.log(dim(`  Vault: ${vaultPath}`));
    console.log();
  }

  // --- Symlinks ---
  if (!q) process.stdout.write("  Syncing symlinks...");
  const stats = syncVault(vaultPath, db);
  if (!q) {
    process.stdout.write(
      `\r  ${ok("Symlinks:")}  created ${stats.created}  updated ${stats.updated}  removed ${stats.removed}  stubs ${stats.stubbed}\n`
    );
    if (stats.errors.length) {
      for (const e of stats.errors) {
        console.log(warn(`  Warning: ${e}`));
      }
    }
  }

  // --- Index ---
  if (!q) process.stdout.write("  Generating index...");
  generateIndex(vaultPath, db);
  if (!q) console.log(`\r  ${ok("Index:")}     _index.md written              `);

  // --- Topic pages ---
  if (!q) process.stdout.write("  Generating topic pages...");
  const topicCount = generateTopicPages(vaultPath, db);
  if (!q) console.log(`\r  ${ok("Topics:")}    ${topicCount} topic page(s) written          `);

  // --- Fix session tags (remove generic #Session) ---
  if (!q) process.stdout.write("  Fixing session tags...");
  const tagStats = fixSessionTags(db);
  if (!q) {
    console.log(
      `\r  ${ok("Tags:")}      ${tagStats.filesModified} file(s) updated (scanned ${tagStats.filesScanned})          `
    );
    if (tagStats.errors.length) {
      for (const e of tagStats.errors) {
        console.log(warn(`  Warning: ${e}`));
      }
    }
  }

  // --- Master notes ---
  if (!q) process.stdout.write("  Generating master notes...");
  const masterCount = generateMasterNotes(vaultPath, db);
  if (!q) console.log(`\r  ${ok("Masters:")}   ${masterCount} master note(s) written         `);

  // Persist vault path so status/open can use it
  saveVaultPath(vaultPath);

  if (!q) {
    console.log();
    console.log(ok(`  Done. Vault ready at: ${vaultPath}`));
    console.log();
  }
}

function cmdStatus(db: Database, opts: { vault?: string }): void {
  const vaultPath = getVaultPath(opts.vault);
  const report = checkHealth(vaultPath, db);

  console.log();
  console.log(header("  PAI Obsidian Vault Status"));
  console.log(dim(`  Vault: ${vaultPath}`));
  console.log();

  if (!existsSync(vaultPath)) {
    console.log(warn("  Vault directory does not exist. Run: pai obsidian sync"));
    console.log();
    return;
  }

  // Summary line
  const healthyCount = report.healthy.length;
  const brokenCount = report.broken.length;
  const orphanedCount = report.orphaned.length;
  const missingCount = report.missing.length;

  console.log(
    `  ${chalk.green("Healthy:")} ${healthyCount}   ` +
      `${chalk.red("Broken:")} ${brokenCount}   ` +
      `${chalk.yellow("Orphaned:")} ${orphanedCount}   ` +
      `${chalk.cyan("Missing:")} ${missingCount}`
  );
  console.log();

  if (report.healthy.length && report.healthy.length <= 10) {
    console.log(bold("  Healthy symlinks:"));
    for (const h of report.healthy) {
      console.log(`    ${chalk.green("✓")} ${bold(h.slug)}  ${dim("→ " + (h.target ?? ""))}`);
    }
    console.log();
  } else if (report.healthy.length > 10) {
    console.log(bold(`  ${report.healthy.length} healthy symlinks (all good)`));
    console.log();
  }

  if (report.broken.length) {
    console.log(err("  Broken symlinks (target missing):"));
    for (const b of report.broken) {
      console.log(`    ${chalk.red("✗")} ${bold(b.slug)}  ${dim(b.notes)}`);
    }
    console.log(dim("  Fix: pai obsidian sync"));
    console.log();
  }

  if (report.orphaned.length) {
    console.log(warn("  Orphaned symlinks (no registry project):"));
    for (const o of report.orphaned) {
      console.log(`    ${chalk.yellow("?")} ${bold(o.slug)}  ${dim(o.notes)}`);
    }
    console.log();
  }

  if (report.missing.length) {
    console.log(warn("  Projects with Notes/ but no vault symlink:"));
    for (const m of report.missing) {
      console.log(`    ${chalk.cyan("→")} ${bold(m.slug)}  ${dim(m.notes)}`);
    }
    console.log();
  }

  if (brokenCount === 0 && orphanedCount === 0 && missingCount === 0) {
    console.log(ok("  Vault is healthy."));
    console.log();
  }
}

function cmdOpen(opts: { vault?: string }): void {
  const vaultPath = getVaultPath(opts.vault);
  // Derive vault name from last path component (Obsidian uses folder name as vault name)
  const parts = vaultPath.split("/").filter(Boolean);
  const vaultName = parts[parts.length - 1] ?? "obsidian-vault";

  if (!existsSync(vaultPath)) {
    console.error(err(`Vault not found at: ${vaultPath}`));
    console.error(dim("  Run: pai obsidian sync"));
    process.exit(1);
  }

  const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
  console.log(dim(`  Opening: ${url}`));
  try {
    execSync(`open "${url}"`, { stdio: "ignore" });
    console.log(ok(`  Opened vault "${vaultName}" in Obsidian.`));
  } catch (e) {
    console.error(err(`  Failed to open Obsidian: ${e}`));
    console.error(dim("  Ensure Obsidian is installed and the vault is registered in Obsidian."));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerObsidianCommands(
  obsidianCmd: Command,
  getDb: () => Database
): void {
  // pai obsidian sync
  obsidianCmd
    .command("sync")
    .description("Sync project Notes/ dirs into vault, generate _index.md and topic pages")
    .option("--vault <path>", "Override vault path (default: ~/.pai/obsidian-vault)")
    .option("--quiet", "Minimal output — suitable for cron/hook use")
    .action((opts: { vault?: string; quiet?: boolean }) => {
      cmdSync(getDb(), opts);
    });

  // pai obsidian status
  obsidianCmd
    .command("status")
    .description("Show vault health: healthy, broken, orphaned, and missing symlinks")
    .option("--vault <path>", "Override vault path")
    .action((opts: { vault?: string }) => {
      cmdStatus(getDb(), opts);
    });

  // pai obsidian open
  obsidianCmd
    .command("open")
    .description("Open the vault in Obsidian (macOS)")
    .option("--vault <path>", "Override vault path")
    .action((opts: { vault?: string }) => {
      cmdOpen(opts);
    });
}
