/**
 * pai backup — snapshot registry, config, and Postgres database.
 *
 * Creates a timestamped backup directory at:
 *   ~/.pai/backups/YYYY-MM-DD-HHmmss/
 *
 * Contents:
 *   registry file        — SQLite registry database (sqlite backend only)
 *   config.json          — PAI daemon config
 *   postgres-pai.sql     — pg_dump of the daemon's Postgres database (via docker exec), row counts verified
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
  chmodSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ok, warn, err, dim, bold } from "../../lib/utils.js";
import { loadConfig, paiConfigFilePath } from "../../../daemon/config.js";
import { backupStorageFiles } from "../../../storage/backup.js";
import { backupPostgres, resolveBackupTarget, type PgRunner } from "./backup-postgres.js";
import { defaultPaiHomeDir, paiHomePath, resolvePaiFile } from "../../../config/pai-home.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_FILE = paiConfigFilePath();

/** Old backups dir, inside ~/.pai/ (pre-2026-09-19). */
export function oldBackupsDir(): string {
  return join(defaultPaiHomeDir(), "backups");
}

/** Backups dir: PAI_HOME/backups if present, else the old ~/.pai/backups
 *  (one-time stderr notice), else the new path. */
export function backupsDirPath(): string {
  return resolvePaiFile(paiHomePath("backups"), [oldBackupsDir()], "pai config migrate --backups");
}

const BACKUPS_DIR = backupsDirPath();
const DOCKER_CONTAINER = "pai-pgvector";

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

const dockerRunner: PgRunner = {
  dump(database, user, destPath) {
    execFileSync("docker", ["inspect", DOCKER_CONTAINER, "--format={{.State.Status}}"], { stdio: "pipe" });
    const sqlFd = openSync(destPath, "w");
    try {
      const dump = spawnSync("docker", ["exec", DOCKER_CONTAINER, "pg_dump", "-U", user, database], {
        stdio: ["pipe", sqlFd, "pipe"],
      });
      if (dump.status !== 0) {
        throw new Error(dump.stderr?.toString().trim() || `pg_dump exited with code ${dump.status}`);
      }
    } finally {
      closeSync(sqlFd);
    }
  },
  count(database, user, table) {
    const r = spawnSync(
      "docker",
      ["exec", DOCKER_CONTAINER, "psql", "-U", user, "-d", database, "-tAc", `SELECT count(*) FROM ${table}`],
      { stdio: "pipe" },
    );
    return r.status === 0 ? Number(r.stdout.toString().trim()) : null;
  },
};

export async function runBackup(opts: { postgres: boolean; dryRun?: boolean }): Promise<void> {
  if (opts.dryRun) {
    const t = resolveBackupTarget(loadConfig().postgres);
    console.log(`Would dump Postgres database "${t.database}" (user ${t.user}) from container ${DOCKER_CONTAINER}`);
    return;
  }
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
      copyFileSync(CONFIG_FILE, dest);
      chmodSync(dest, 0o600);
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
      const target = resolveBackupTarget(config.postgres);
      console.log(dim(`  Database: ${target.database}`));
      backupPostgres(target, sqlDest, dockerRunner);
      results.push({ label: "Postgres DB", path: sqlDest, size: fileSize(sqlDest), status: ok("ok (verified)") });
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
}
