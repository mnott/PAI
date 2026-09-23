/**
 * pai restore [path] — restore from a backup created by `pai backup`.
 *
 * If no path is given, lists available backups and restores the latest one
 * after prompting for confirmation.
 *
 * Restores:
 *   registry database    — SQLite registry database
 *   config.json          — PAI daemon config
 *   postgres-pai.sql     — Postgres dump (piped into psql via docker exec)
 *   federation database  — Legacy SQLite federation DB (if present)
 */

import type { Command } from "commander";
import {
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { ok, warn, err, dim, bold } from "../utils.js";
import { loadConfig, paiConfigFilePath } from "../../daemon/config.js";
import { inspectStorageBackup, restoreStorageFiles } from "../../storage/backup.js";
import { backupsDirPath } from "./backup.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME = homedir();
const CONFIG_FILE = paiConfigFilePath();
const BACKUPS_DIR = backupsDirPath();
const DOCKER_CONTAINER = "pai-pgvector";
const PG_DATABASE = "pai";
const PG_USER = "pai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function listBackups(): string[] {
  if (!existsSync(BACKUPS_DIR)) return [];
  return readdirSync(BACKUPS_DIR)
    .filter((name) => {
      const full = join(BACKUPS_DIR, name);
      return statSync(full).isDirectory() && /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(name);
    })
    .sort()
    .reverse(); // newest first
}

function formatBackupDate(name: string): string {
  // YYYY-MM-DD-HHmmss → "YYYY-MM-DD HH:mm:ss"
  const m = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return name;
  return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
}

function backupContents(backupDir: string): string[] {
  try {
    return readdirSync(backupDir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRestoreCommands(program: Command): void {
  program
    .command("restore [backup-path]")
    .description("Restore from a backup directory (created by pai backup)")
    .option("--no-postgres", "Skip restoring the Postgres database")
    .option("--yes", "Skip confirmation prompt (non-interactive)")
    .action(async (backupPath: string | undefined, opts: { postgres: boolean; yes: boolean }) => {

      // ------------------------------------------------------------------
      // 1. Determine backup directory
      // ------------------------------------------------------------------

      let resolvedDir: string;

      if (backupPath) {
        resolvedDir = backupPath.startsWith("~")
          ? backupPath.replace(/^~/, HOME)
          : backupPath;

        if (!existsSync(resolvedDir)) {
          console.error(err(`Backup directory not found: ${resolvedDir}`));
          process.exitCode = 1;
          return;
        }
      } else {
        // No path given — pick from available backups
        const backups = listBackups();
        if (backups.length === 0) {
          console.error(err(`No backups found in ${BACKUPS_DIR}`));
          console.log(dim("  Run 'pai backup' to create one."));
          process.exitCode = 1;
          return;
        }

        console.log(`\n${bold("Available backups")} (newest first):\n`);
        backups.forEach((name, i) => {
          const dir = join(BACKUPS_DIR, name);
          const contents = backupContents(dir).join(", ");
          const marker = i === 0 ? ok(" ← latest") : "";
          console.log(`  ${bold(String(i + 1).padStart(2))}. ${formatBackupDate(name)}${marker}`);
          console.log(`      ${dim(dir)}`);
          console.log(`      ${dim("Contents:")} ${contents}`);
        });

        console.log();
        resolvedDir = join(BACKUPS_DIR, backups[0]);
        console.log(dim(`Using latest backup: ${resolvedDir}\n`));
      }

      // ------------------------------------------------------------------
      // 2. Inventory what's in the backup
      // ------------------------------------------------------------------

      const inventory = inspectStorageBackup(resolvedDir);
      const hasConfig   = existsSync(join(resolvedDir, "config.json"));
      const hasSql      = existsSync(join(resolvedDir, "postgres-pai.sql"));

      console.log(`${bold("Backup contents:")}`);
      console.log(`  Registry DB          ${inventory.hasRegistry ? ok("present") : warn("missing")}`);
      console.log(`  config.json          ${hasConfig   ? ok("present") : warn("missing")}`);
      console.log(`  postgres-pai.sql     ${hasSql && opts.postgres ? ok("present") : hasSql ? warn("present (skipped via --no-postgres)") : warn("missing")}`);
      if (inventory.hasFederation) {
        console.log(`  Federation DB        ${ok("present")} ${dim("(legacy)")}`);
      }

      // ------------------------------------------------------------------
      // 3. Confirm
      // ------------------------------------------------------------------

      console.log(`\n${warn("WARNING:")} This will OVERWRITE your current PAI data.`);
      if (hasSql && opts.postgres) {
        console.log(warn("  Postgres database will be dropped and recreated from the backup."));
      }

      const proceed = opts.yes || await confirm("Proceed with restore?");
      if (!proceed) {
        console.log(dim("Restore cancelled."));
        return;
      }

      console.log();

      const results: { label: string; status: string }[] = [];

      // ------------------------------------------------------------------
      // 4. Restore registry (+ legacy federation) SQLite DB, sqlite backend only
      // ------------------------------------------------------------------

      for (const r of restoreStorageFiles(loadConfig(), resolvedDir)) {
        results.push({
          label: r.label,
          status: r.status === "ok" ? ok("restored") : r.status === "skipped" ? warn("missing in backup — skipped") : err(`failed: ${r.error}`),
        });
      }

      // ------------------------------------------------------------------
      // 5. Restore config.json
      // ------------------------------------------------------------------

      if (hasConfig) {
        try {
          mkdirSync(dirname(CONFIG_FILE), { recursive: true });
          copyFileSync(join(resolvedDir, "config.json"), CONFIG_FILE);
          results.push({ label: "Config", status: ok("restored") });
        } catch (e) {
          results.push({ label: "Config", status: err(`failed: ${e}`) });
        }
      } else {
        results.push({ label: "Config", status: warn("missing in backup — skipped") });
      }

      // ------------------------------------------------------------------
      // 6. Restore Postgres via docker exec
      // ------------------------------------------------------------------

      if (hasSql && opts.postgres) {
        console.log(dim("  Restoring Postgres database (this may take a while)..."));
        try {
          // Verify container is running
          execSync(`docker inspect ${DOCKER_CONTAINER} --format='{{.State.Status}}'`, {
            stdio: "pipe",
          });

          // Drop and recreate the database, then restore
          const dropCreate = `docker exec ${DOCKER_CONTAINER} psql -U ${PG_USER} -c "DROP DATABASE IF EXISTS ${PG_DATABASE}; CREATE DATABASE ${PG_DATABASE} OWNER ${PG_USER};"`;
          execSync(dropCreate, { stdio: "pipe", shell: true as unknown as string });

          // Pipe the SQL dump into psql
          const sqlContent = readFileSync(join(resolvedDir, "postgres-pai.sql"), "utf8");
          const psqlResult = spawnSync(
            "docker",
            ["exec", "-i", DOCKER_CONTAINER, "psql", "-U", PG_USER, PG_DATABASE],
            { input: sqlContent, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
          );

          if (psqlResult.status !== 0) {
            const errMsg = psqlResult.stderr?.split("\n")[0] ?? "unknown error";
            results.push({ label: "Postgres DB", status: err(`failed: ${errMsg}`) });
          } else {
            results.push({ label: "Postgres DB", status: ok("restored") });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
          results.push({ label: "Postgres DB", status: err(`failed: ${msg}`) });
          console.log(warn(`  Is Docker running with container '${DOCKER_CONTAINER}'?`));
        }
      } else if (!hasSql || !opts.postgres) {
        const reason = !hasSql ? "no SQL dump in backup" : "--no-postgres";
        results.push({ label: "Postgres DB", status: dim(`skipped (${reason})`) });
      }

      // ------------------------------------------------------------------
      // Summary
      // ------------------------------------------------------------------

      console.log(`\n${bold("Restore complete:")}\n`);
      const labelWidth = Math.max(...results.map((r) => r.label.length)) + 2;
      for (const r of results) {
        console.log(`  ${bold(r.label.padEnd(labelWidth))} ${r.status}`);
      }

      const hasErrors = results.some((r) => r.status.includes("\u001b[31m"));
      if (!hasErrors) {
        console.log(`\n  ${ok("All done.")} You may need to restart the PAI daemon.\n`);
        console.log(`  ${dim("Restart:")} pai daemon restart\n`);
      } else {
        console.log(`\n  ${warn("Some items failed — check output above.")}\n`);
        process.exitCode = 1;
        return;
      }
    });
}
