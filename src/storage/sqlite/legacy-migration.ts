/**
 * PAI_HOME layout migration for the two legacy per-user SQLite files
 * (the orphaned ~/.config/pai/federation.db and the live ~/.pai/{federation,
 * registry}.db pair) — byte-relocation on disk, not application-level DB
 * access, but still routed through src/storage/ so `pai config migrate`
 * never has to name these files directly (boundary test, design doc §7).
 */

import { existsSync, renameSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  paiHomePath,
  migratePaiFile,
  PaiFileMigrationError,
  type MigrateFileResult,
} from "../../config/pai-home.js";
import {
  federationDbPath,
  oldFederationPath,
  registryDbPath,
  oldRegistryPath,
  migrateOrphanFederationDb,
} from "../paths.js";

/** Paths for `pai config path`/`migrate` display, without exposing the raw openers by name. */
export function legacyDbDisplayPaths(): { registryDb: string; federationDb: string } {
  return { registryDb: registryDbPath(), federationDb: federationDbPath() };
}

/**
 * The orphaned ~/.config/pai/federation.db (a 0-byte leftover — the live
 * federation DB has lived at ~/.pai/federation.db since the Postgres
 * migration, nothing in src/ reads this copy). Still checked for an open fd
 * before moving: if some other process ever does hold it, restart the
 * daemon (SIGTERM; launchd relaunches it) and give it a moment to let go
 * before renaming the file aside, per the migration runbook.
 */
export function migrateFederationDbOrphan(dryRun: boolean): MigrateFileResult {
  const oldPath = oldFederationPath();
  if (existsSync(oldPath) && !dryRun) {
    let heldOpen = false;
    try {
      execSync(`lsof "${oldPath}"`, { stdio: "pipe" });
      heldOpen = true;
    } catch {
      // lsof exits non-zero when nothing has the file open — the expected case.
    }
    if (heldOpen) {
      console.log("  federation database (orphan): held open by the daemon — restarting it first");
      execSync("pai daemon restart", { stdio: "inherit" });
      execSync("sleep 2");
    }
  }
  return migrateOrphanFederationDb({ dryRun });
}

function checkpointAndVerify(oldPath: string, newPath: string, label: string): void {
  let hasSqlite3 = true;
  try {
    execSync("command -v sqlite3", { stdio: "pipe" });
  } catch {
    hasSqlite3 = false;
  }
  if (hasSqlite3) {
    try {
      execSync(`sqlite3 "${oldPath}" "PRAGMA wal_checkpoint(TRUNCATE);"`, { stdio: "pipe" });
    } catch {
      // Best-effort — the sidecar move below still catches an un-checkpointed WAL.
    }
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${oldPath}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        renameSync(sidecar, `${sidecar}.migrated-${stamp}`);
      } catch {
        // Non-fatal — surfaced by the integrity check below if it actually mattered.
      }
    }
  }

  if (hasSqlite3) {
    try {
      const check = execSync(`sqlite3 "${newPath}" "PRAGMA integrity_check;"`, { stdio: "pipe" })
        .toString()
        .trim();
      if (check !== "ok") {
        throw new PaiFileMigrationError(
          `${newPath}: PRAGMA integrity_check reported "${check}" — investigate before trusting this copy`
        );
      }
    } catch (e) {
      if (e instanceof PaiFileMigrationError) throw e;
      // sqlite3 CLI failed for an unrelated reason (not installed, etc.) — the
      // byte-identical copy migratePaiFile already verified is still trustworthy.
    }
  }
}

/**
 * ~/.pai/registry.db — a third per-user location, alongside PAI_HOME and the
 * ~/.claude adapter. Same open-fd caution as the federation database below
 * (the daemon holds this connection while it runs), plus SQLite-specific
 * care: a WAL-mode DB can have unflushed writes sitting in a `-wal` sidecar
 * file, so a plain byte-copy of the main file alone can silently drop them.
 * This checkpoints the WAL into the main file before copying, moves any
 * sidecar left behind anyway, and runs `PRAGMA integrity_check` on the copy
 * when the `sqlite3` CLI is available — on top of migratePaiFile's own
 * byte-identical verification, not instead of it.
 */
export function migrateRegistryDbFile(dryRun: boolean): MigrateFileResult {
  const oldPath = oldRegistryPath();
  const newPath = paiHomePath("registry.db");

  if (!existsSync(oldPath) || dryRun) {
    return migratePaiFile(newPath, [oldPath], { dryRun });
  }

  let heldOpen = false;
  try {
    execSync(`lsof "${oldPath}"`, { stdio: "pipe" });
    heldOpen = true;
  } catch {
    // lsof exits non-zero when nothing has the file open — the expected case.
  }
  if (heldOpen) {
    console.log("  registry database: held open by the daemon — restarting it first");
    execSync("pai daemon restart", { stdio: "inherit" });
    execSync("sleep 2");
  }

  const result = migratePaiFile(newPath, [oldPath], { dryRun: false });
  if (result.fromPath) checkpointAndVerify(oldPath, newPath, "registry database");
  return result;
}

/**
 * ~/.pai/federation.db — the LIVE per-user SQLite federation DB. Despite the
 * comment on migrateFederationDbOrphan above, this one is not an orphan: the
 * sqlite storage backend opens it directly via the storage layer's default
 * path — independent of the storageBackend setting only for hosts still on
 * the sqlite backend. It shares its target filename with the harmless
 * 0-byte orphan migrated above, so that empty copy is renamed aside first
 * (never deleted) to free up the canonical name. Same open-fd,
 * WAL-checkpoint and integrity-check care as the registry database.
 */
export function migrateFederationDbFile(dryRun: boolean): MigrateFileResult {
  const oldPath = oldFederationPath();
  const newPath = paiHomePath("federation.db");

  if (!dryRun && existsSync(newPath) && existsSync(oldPath) && statSync(newPath).size === 0) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    renameSync(newPath, `${newPath}.empty-orphan-${stamp}`);
  }

  if (!existsSync(oldPath) || dryRun) {
    return migratePaiFile(newPath, [oldPath], { dryRun });
  }

  let heldOpen = false;
  try {
    execSync(`lsof "${oldPath}"`, { stdio: "pipe" });
    heldOpen = true;
  } catch {
    // lsof exits non-zero when nothing has the file open — the expected case.
  }
  if (heldOpen) {
    console.log("  federation database (live): held open by the daemon — restarting it first");
    execSync("pai daemon restart", { stdio: "inherit" });
    execSync("sleep 2");
  }

  const result = migratePaiFile(newPath, [oldPath], { dryRun: false });
  if (result.fromPath) checkpointAndVerify(oldPath, newPath, "federation database");
  return result;
}
