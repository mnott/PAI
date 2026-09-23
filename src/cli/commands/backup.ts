/**
 * pai backup — snapshot registry, config, and Postgres database.
 *
 * Creates a timestamped backup directory at:
 *   ~/.pai/backups/YYYY-MM-DD-HHmmss/
 *
 * Contents:
 *   registry file        — SQLite registry database (sqlite backend only)
 *   config.json          — PAI daemon config
 *   postgres-pai.sql     — pg_dump of the Postgres "pai" database (via docker exec)
 */

import type { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { ok, warn, err, dim, bold } from "../utils.js";
import { loadConfig, paiConfigFilePath } from "../../daemon/config.js";
import { backupStorageFiles } from "../../storage/backup.js";
import { paiHomePath, resolvePaiFile } from "../../config/pai-home.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME = homedir();
const CONFIG_FILE = paiConfigFilePath();

/** Old backups dir, inside ~/.pai/ (pre-2026-09-19). */
export function oldBackupsDir(): string {
  return join(HOME, ".pai", "backups");
}

/** Backups dir: PAI_HOME/backups if present, else the old ~/.pai/backups
 *  (one-time stderr notice), else the new path. */
export function backupsDirPath(): string {
  return resolvePaiFile(paiHomePath("backups"), [oldBackupsDir()], "pai config migrate --backups");
}

const BACKUPS_DIR = backupsDirPath();
const DOCKER_CONTAINER = "pai-pgvector";
const PG_DATABASE = "pai";
const PG_USER = "pai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD}-${HH}${mm}${ss}`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileSize(path: string): string {
  try {
    return fmtBytes(statSync(path).size);
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBackupCommands(program: Command): void {
  program
    .command("backup")
    .description("Backup registry, config, and Postgres database to PAI_HOME/backups/")
    .option("--no-postgres", "Skip the Postgres pg_dump (faster, registry+config only)")
    .action(async (opts: { postgres: boolean }) => {
      const ts = timestamp();
      const backupDir = join(BACKUPS_DIR, ts);

      console.log(dim(`Creating backup: ${backupDir}`));
      mkdirSync(backupDir, { recursive: true });

      const results: { label: string; path: string; size: string; status: string }[] = [];
      const config = loadConfig();

      // ------------------------------------------------------------------
      // 1. Registry (+ legacy federation) SQLite DB, sqlite backend only
      // ------------------------------------------------------------------

      for (const r of backupStorageFiles(config, backupDir)) {
        results.push({
          label: r.label,
          path: r.path,
          size: r.status === "ok" ? fileSize(r.path) : "-",
          status:
            r.status === "ok" ? ok("ok") : r.status === "skipped" ? warn("not found — skipped") : err(`failed: ${r.error}`),
        });
      }

      // ------------------------------------------------------------------
      // 2. Config file
      // ------------------------------------------------------------------

      if (existsSync(CONFIG_FILE)) {
        const dest = join(backupDir, "config.json");
        try {
          const { copyFileSync } = await import("node:fs");
          copyFileSync(CONFIG_FILE, dest);
          results.push({ label: "Config", path: dest, size: fileSize(dest), status: ok("ok") });
        } catch (e) {
          results.push({ label: "Config", path: dest, size: "-", status: err(`failed: ${e}`) });
        }
      } else {
        results.push({ label: "Config", path: CONFIG_FILE, size: "-", status: warn("not found — skipped") });
      }

      // ------------------------------------------------------------------
      // 3. Postgres pg_dump via docker exec
      // ------------------------------------------------------------------

      if (opts.postgres) {
        const sqlDest = join(backupDir, "postgres-pai.sql");
        console.log(dim(`  Running pg_dump on ${DOCKER_CONTAINER} (this may take a moment)...`));
        try {
          // Check Docker is running and container exists
          execSync(`docker inspect ${DOCKER_CONTAINER} --format='{{.State.Status}}'`, {
            stdio: "pipe",
          });

          execSync(
            `docker exec ${DOCKER_CONTAINER} pg_dump -U ${PG_USER} ${PG_DATABASE} > "${sqlDest}"`,
            { stdio: ["pipe", "pipe", "pipe"], shell: true as unknown as string }
          );
          results.push({ label: "Postgres DB", path: sqlDest, size: fileSize(sqlDest), status: ok("ok") });
        } catch (e) {
          const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
          results.push({ label: "Postgres DB", path: sqlDest, size: "-", status: err(`failed: ${msg}`) });
          console.log(warn(`  Postgres backup failed. Is Docker running with container '${DOCKER_CONTAINER}'?`));
        }
      } else {
        results.push({ label: "Postgres DB", path: "-", size: "-", status: dim("skipped (--no-postgres)") });
      }

      // ------------------------------------------------------------------
      // Summary
      // ------------------------------------------------------------------

      console.log(`\n${bold("Backup complete:")} ${backupDir}\n`);

      const labelWidth = Math.max(...results.map((r) => r.label.length)) + 2;
      for (const r of results) {
        const label = r.label.padEnd(labelWidth);
        console.log(`  ${bold(label)} ${r.status}  ${dim(r.size)}`);
      }

      console.log(`\n  ${dim("Path:")} ${backupDir}`);
      console.log(`  ${dim("To restore:")} pai restore ${backupDir}\n`);
    });
}
