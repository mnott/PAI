/**
 * pai backup — snapshot registry, config, and Postgres database.
 *
 * Creates a timestamped backup directory at:
 *   ~/.pai/backups/YYYY-MM-DD-HHmmss/
 *
 * Contents:
 *   registry.db          — SQLite registry database
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
import { loadConfig } from "../../daemon/config.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME = homedir();
const REGISTRY_DB = join(HOME, ".pai", "registry.db");
const CONFIG_FILE = join(HOME, ".config", "pai", "config.json");
const BACKUPS_DIR = join(HOME, ".pai", "backups");
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
    .description("Backup registry, config, and Postgres database to ~/.pai/backups/")
    .option("--no-postgres", "Skip the Postgres pg_dump (faster, registry+config only)")
    .action(async (opts: { postgres: boolean }) => {
      const ts = timestamp();
      const backupDir = join(BACKUPS_DIR, ts);

      console.log(dim(`Creating backup: ${backupDir}`));
      mkdirSync(backupDir, { recursive: true });

      const results: { label: string; path: string; size: string; status: string }[] = [];

      // ------------------------------------------------------------------
      // 1. Registry SQLite DB
      // ------------------------------------------------------------------

      if (existsSync(REGISTRY_DB)) {
        const dest = join(backupDir, "registry.db");
        try {
          copyFileSync(REGISTRY_DB, dest);
          results.push({ label: "Registry DB", path: dest, size: fileSize(dest), status: ok("ok") });
        } catch (e) {
          results.push({ label: "Registry DB", path: dest, size: "-", status: err(`failed: ${e}`) });
        }
      } else {
        results.push({ label: "Registry DB", path: REGISTRY_DB, size: "-", status: warn("not found — skipped") });
      }

      // ------------------------------------------------------------------
      // 2. Config file
      // ------------------------------------------------------------------

      if (existsSync(CONFIG_FILE)) {
        const dest = join(backupDir, "config.json");
        try {
          copyFileSync(CONFIG_FILE, dest);
          results.push({ label: "Config", path: dest, size: fileSize(dest), status: ok("ok") });
        } catch (e) {
          results.push({ label: "Config", path: dest, size: "-", status: err(`failed: ${e}`) });
        }
      } else {
        results.push({ label: "Config", path: CONFIG_FILE, size: "-", status: warn("not found — skipped") });
      }

      // ------------------------------------------------------------------
      // 3. Optional: Federation SQLite (legacy)
      // ------------------------------------------------------------------

      const federationDb = join(HOME, ".pai", "federation.db");
      if (existsSync(federationDb)) {
        const dest = join(backupDir, "federation.db");
        try {
          copyFileSync(federationDb, dest);
          results.push({ label: "Federation DB (legacy)", path: dest, size: fileSize(dest), status: ok("ok") });
        } catch (e) {
          results.push({ label: "Federation DB (legacy)", path: dest, size: "-", status: warn(`skipped: ${e}`) });
        }
      }

      // ------------------------------------------------------------------
      // 4. Postgres pg_dump via docker exec
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
            { stdio: ["pipe", "pipe", "pipe"], shell: true }
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
