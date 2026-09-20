/**
 * `pai config` — the PAI_HOME namespace dir (~/.claude/pai by default) and
 * moving the per-user files that live under it: config.json, workers.yaml,
 * whisper-rules.md, advisor-mode.json, session-state/, and the remaining
 * per-subsystem state files/dirs migrated from ~/.config/pai on 2026-09-19
 * (session-scan-cache.json, queries/, summary-cooldowns.json,
 * work-queue.json, kg-backfill-state.json, voices.json, federation.db),
 * plus ~/.pai/registry.db (`registry.db`) and the two content dirs that get
 * an adapter symlink back to ~/.claude, `agents/` and `commands/`. History/,
 * agent-sessions.json, session-routing.json and security-events.jsonl move
 * only with `--history`; logs/workers only with `--logs` — both are written
 * by hooks on every live session and are refused while a worker is RUNNING.
 */

import type { Command } from "commander";
import { existsSync, renameSync, statSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  paiHomeDir,
  paiHomePath,
  migratePaiFile,
  PaiFileMigrationError,
  type MigrateFileResult,
  type MigrateDirResult,
} from "../../config/pai-home.js";
import { paiConfigFilePath, migrateConfigFile } from "../../daemon/config.js";
import { workersYamlPath, relocateWorkersYaml } from "../../workers/workers-config.js";
import { registryDbPath, oldRegistryPath } from "../../registry/db.js";
import { federationDbPath, oldFederationPath } from "../../memory/db.js";
import { STATE_FILE as schedulerStatePath, migrateSchedulerState } from "../../tasks/poller.js";
import { migrateIdentityFile } from "../../memory/wakeup.js";
import { migrateScanConfig } from "./registry/scan.js";
import { oldBackupsDir, backupsDirPath } from "./backup.js";
import { defaultVaultPath, oldDefaultVaultPath, migrateObsidianVaultDir } from "../../obsidian/sync/generate.js";
import { getConfigObsidianVaultPathRaw, saveVaultPath as saveObsidianVaultPath } from "./obsidian.js";
import { migrateAgentsDir, migrateCommandsDir, type MigrateContentDirResult } from "../../config/adapter-content.js";
import {
  whisperRulesPath,
  advisorModePath,
  sessionStateDir,
  migrateWhisperRules,
  migrateAdvisorMode,
  migrateSessionStateDir,
  migrateVoicesJson,
  migrateOrphanFederationDb,
  migrateSessionStopLock,
  migrateLastHousekeeping,
  migrateHistoryDir,
  migrateAgentSessions,
  migrateSessionRouting,
  migrateSecurityEvents,
} from "../../config/pai-files.js";
import { scanCacheFilePath, migrateSessionScanCache } from "../../cli/lib/session-scan.js";
import { queriesDirPath, migrateQueriesDir } from "../../zettelkasten/query-feedback.js";
import { migrateSummaryCooldowns } from "../../daemon/session-summary-worker.js";
import { migrateWorkQueue } from "../../daemon/work-queue.js";
import { migrateKgBackfillState } from "../../memory/kg-backfill.js";
import { readWorkersSection, expandHome } from "../../workers/config.js";
import { migrateWorkerLogs, WorkerLogsMigrationError, activeSpawnedWorkerCount } from "../../workers/logs-migrate.js";
import { ok, err, dim, bold } from "../utils.js";

/**
 * The orphaned ~/.config/pai/federation.db (a 0-byte leftover — the live
 * federation DB has lived at ~/.pai/federation.db since the Postgres
 * migration, nothing in src/ reads this copy). Still checked for an open fd
 * before moving: if some other process ever does hold it, restart the
 * daemon (SIGTERM; launchd relaunches it) and give it a moment to let go
 * before renaming the file aside, per the migration runbook.
 */
function migrateFederationDbOrphan(dryRun: boolean): MigrateFileResult {
  const oldPath = join(homedir(), ".config", "pai", "federation.db");
  if (existsSync(oldPath) && !dryRun) {
    let heldOpen = false;
    try {
      execSync(`lsof "${oldPath}"`, { stdio: "pipe" });
      heldOpen = true;
    } catch {
      // lsof exits non-zero when nothing has the file open — the expected case.
    }
    if (heldOpen) {
      console.log(dim("  federation.db: held open by the daemon — restarting it first"));
      execSync("pai daemon restart", { stdio: "inherit" });
      execSync("sleep 2");
    }
  }
  return migrateOrphanFederationDb({ dryRun });
}

/**
 * ~/.pai/registry.db — a third per-user location, alongside PAI_HOME and the
 * ~/.claude adapter. Same open-fd caution as federation.db above (the daemon
 * holds this connection while it runs), plus SQLite-specific care: a
 * WAL-mode DB can have unflushed writes sitting in a `-wal` sidecar file, so
 * a plain byte-copy of `registry.db` alone can silently drop them. This
 * checkpoints the WAL into the main file before copying, moves any sidecar
 * left behind anyway, and runs `PRAGMA integrity_check` on the copy when the
 * `sqlite3` CLI is available — on top of migratePaiFile's own byte-identical
 * verification, not instead of it.
 */
function migrateRegistryDb(dryRun: boolean): MigrateFileResult {
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
    console.log(dim("  registry.db: held open by the daemon — restarting it first"));
    execSync("pai daemon restart", { stdio: "inherit" });
    execSync("sleep 2");
  }

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

  const result = migratePaiFile(newPath, [oldPath], { dryRun: false });

  if (result.fromPath) {
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

  return result;
}

/**
 * ~/.pai/federation.db — the LIVE per-user SQLite federation DB. Despite the
 * comment on migrateFederationDbOrphan above, this one is not an orphan: the
 * daemon's dispatcher, scheduler and session-summary-worker, plus kg-backfill
 * and several `pai memory`/`pai zettel`/`pai db` commands, open it directly
 * via openFederation()'s default path — independent of the storageBackend
 * setting, which only gates the search/stats StorageBackend abstraction.
 * It shares its target filename with the harmless 0-byte
 * ~/.config/pai/federation.db orphan migrated above, so that empty copy is
 * renamed aside first (never deleted) to free up the canonical name. Same
 * open-fd, WAL-checkpoint and integrity-check care as registry.db.
 */
function migrateFederationDbLive(dryRun: boolean): MigrateFileResult {
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
    console.log(dim("  federation.db: held open by the daemon — restarting it first"));
    execSync("pai daemon restart", { stdio: "inherit" });
    execSync("sleep 2");
  }

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

  const result = migratePaiFile(newPath, [oldPath], { dryRun: false });

  if (result.fromPath) {
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

  return result;
}

function sha256FileSync(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFilesRelative(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFilesRelative(full, base));
    } else {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

export interface MigrateBackupsLegacyResult {
  fromDir: string | null;
  toDir: string;
  dryRun: boolean;
  filesVerified?: number;
  note?: string;
}

/**
 * ~/.pai/backups/ — pre-PAI_HOME `pai backup` snapshots (registry.db,
 * config.json, federation.db, postgres-pai.sql per timestamped run). Moved
 * into PAI_HOME/backups/legacy-pai-backups/ rather than merged into
 * PAI_HOME/backups/ directly, since that directory now holds newly created
 * backups going forward and the legacy runs are kept as a clearly-labelled
 * historical archive. Unlike migratePaiDir's plain rename-per-entry, this
 * copies the whole tree then verifies every file byte-identical (sha256)
 * before renaming the old dir aside — these snapshots include a 1.4GB
 * federation.db and a 1GB pg_dump, worth the extra care.
 */
function migrateBackupsLegacy(dryRun: boolean): MigrateBackupsLegacyResult {
  const oldDir = oldBackupsDir();
  const newDir = paiHomePath("backups", "legacy-pai-backups");

  if (!existsSync(oldDir)) {
    return { fromDir: null, toDir: newDir, dryRun, note: "nothing to migrate — directory does not exist yet" };
  }
  if (existsSync(newDir)) {
    return { fromDir: oldDir, toDir: newDir, dryRun, note: "already at new location" };
  }
  if (dryRun) {
    return { fromDir: oldDir, toDir: newDir, dryRun: true };
  }

  cpSync(oldDir, newDir, { recursive: true });

  const relFiles = walkFilesRelative(oldDir);
  for (const rel of relFiles) {
    const a = sha256FileSync(join(oldDir, rel));
    const b = sha256FileSync(join(newDir, rel));
    if (a !== b) {
      throw new PaiFileMigrationError(
        `${join(newDir, rel)}: copy did not match ${join(oldDir, rel)} (sha256 mismatch) — aborting, old dir left in place`
      );
    }
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  renameSync(oldDir, `${oldDir}.migrated-${stamp}`);

  return { fromDir: oldDir, toDir: newDir, dryRun: false, filesVerified: relFiles.length };
}

export interface MigrateObsidianVaultPathConfigResult {
  status: "rewritten" | "would-rewrite" | "already-new" | "not-set" | "custom";
  from?: string;
  to?: string;
}

/**
 * `pai obsidian sync --vault` used to save the then-default path
 * (~/.pai/obsidian-vault) into config.json's obsidianVaultPath explicitly.
 * migrateObsidianVaultDir above moves the directory but has no reason to
 * touch config.json, so without this every later sync (including the one
 * the session-stop hook runs) kept regenerating the vault at the old path.
 * Only rewrites when the stored value is EXACTLY the old default — a custom
 * vault path is left alone.
 */
export function migrateObsidianVaultPathConfig(dryRun: boolean): MigrateObsidianVaultPathConfigResult {
  const current = getConfigObsidianVaultPathRaw();
  const newPath = paiHomePath("obsidian-vault");

  if (!current) return { status: "not-set" };
  if (current === newPath) return { status: "already-new", from: current, to: newPath };
  if (current !== oldDefaultVaultPath()) return { status: "custom", from: current };
  if (dryRun) return { status: "would-rewrite", from: current, to: newPath };

  saveObsidianVaultPath(newPath);
  return { status: "rewritten", from: current, to: newPath };
}

export function registerConfigCommands(configCmd: Command): void {
  configCmd
    .command("path")
    .description("Print the PAI_HOME namespace dir and each resolved per-user file")
    .action(() => {
      console.log(bold("PAI_HOME: ") + paiHomeDir());
      console.log(`  config.json:              ${paiConfigFilePath()}`);
      console.log(`  workers.yaml:             ${workersYamlPath()}`);
      console.log(`  whisper-rules.md:         ${whisperRulesPath()}`);
      console.log(`  advisor-mode.json:        ${advisorModePath()}`);
      console.log(`  session-state/:           ${sessionStateDir()}`);
      console.log(`  session-scan-cache.json:  ${scanCacheFilePath()}`);
      console.log(`  queries/:                 ${queriesDirPath()}`);
      console.log(`  summary-cooldowns.json, work-queue.json, kg-backfill-state.json,`);
      console.log(`  voices.json, federation.db (orphan): all under PAI_HOME`);
      console.log(`  logs/workers/:            ${paiHomePath("logs", "workers")} (pass --logs to move)`);
      console.log(`  History/:                 ${paiHomePath("History")} (pass --history to move)`);
      console.log(`  agent-sessions.json, session-routing.json, History/security/security-events.jsonl:`);
      console.log(`                            all under PAI_HOME (pass --history to move)`);
      console.log(`  registry.db:              ${registryDbPath()}`);
      console.log(`  federation.db:            ${federationDbPath()}`);
      console.log(`  backups/:                 ${backupsDirPath()}`);
      console.log(`  obsidian-vault/:          ${defaultVaultPath()}`);
      console.log(`  scheduler-state.json:     ${schedulerStatePath}`);
      console.log(`  identity.txt:             ${paiHomePath("identity.txt")} (L0 wake-up identity, optional)`);
      console.log(`  registry-scan.json:       ${paiHomePath("registry-scan.json")}`);
      console.log(`  agents/:                  ${paiHomePath("agents")} (~/.claude/Agents symlinks here after migrate)`);
      console.log(`  commands/:                ${paiHomePath("commands")} (~/.claude/Commands symlinks here after migrate)`);
    });

  configCmd
    .command("migrate")
    .description(
      "Move config.json, workers.yaml, whisper-rules.md, advisor-mode.json, session-state/,\n" +
        "session-scan-cache.json, queries/, summary-cooldowns.json, work-queue.json,\n" +
        "kg-backfill-state.json, voices.json, the orphaned federation.db,\n" +
        "~/.pai/registry.db, ~/.pai/federation.db (live), ~/.pai/backups/,\n" +
        "~/.pai/obsidian-vault/, ~/.pai/scheduler-state.json, and ~/.claude/Agents/,\n" +
        "~/.claude/Commands/ into PAI_HOME.\n" +
        "registry.db and federation.db each get an extra WAL checkpoint and PRAGMA\n" +
        "integrity_check (sqlite3 CLI, if present) on top of the byte-identical copy.\n" +
        "backups/ is copied and sha256-verified file-by-file into\n" +
        "backups/legacy-pai-backups/ rather than merged in place. Agents/ and Commands/ each\n" +
        "get a symlink left at the old ~/.claude path once their content has moved, so\n" +
        "Claude Code still finds them at its fixed harness paths.\n" +
        "Each file is copied, verified byte-identical, then the old file is renamed to\n" +
        "<name>.migrated-<YYYYMMDD> (never deleted); directories move their contents, then\n" +
        "the emptied old directory is renamed the same way. Idempotent — entries already at\n" +
        "the new location, or with nothing old to migrate, are skipped."
    )
    .option("--dry-run", "Print the plan without writing anything")
    .option(
      "--logs",
      "Also move ~/.claude/logs/workers into PAI_HOME: an atomic rename plus a\n" +
        "      symlink left at the old path, so any worker still writing there\n" +
        "      keeps landing in the new directory (falls back to copy+verify\n" +
        "      across volumes, refusing while a worker is RUNNING — see\n" +
        "      `pai worker ps` — only in that fallback case)"
    )
    .option(
      "--history",
      "Also move ~/.claude/History/, agent-sessions.json, session-routing.json\n" +
        "      and history/security/security-events.jsonl into PAI_HOME. These are\n" +
        "      written by hooks on EVERY session's every turn, not just spawned\n" +
        "      workers — refuses while any worker other than the interactive\n" +
        "      session is RUNNING (see `pai worker ps`), but that guard cannot see\n" +
        "      OTHER interactive `claude` sessions on this machine. Confirm none\n" +
        "      are active (`ps aux | grep claude`, `aibroker sessions list`) before\n" +
        "      passing this flag."
    )
    .action((opts: { dryRun?: boolean; logs?: boolean; history?: boolean }) => {
      const dryRun = !!opts.dryRun;
      let hadError = false;

      const report = (label: string, fn: () => MigrateFileResult) => {
        try {
          const r = fn();
          if (r.fromPath === null) {
            console.log(dim(`  ${label}: ${r.note ?? "nothing to migrate"} (${r.toPath})`));
          } else if (r.dryRun) {
            console.log(dim(`  ${label}: would move ${r.fromPath} → ${r.toPath}`));
          } else {
            console.log(ok(`  ${label}: `) + `${r.fromPath} → ${r.toPath}` + (r.note ? dim(` (${r.note})`) : ""));
          }
        } catch (e) {
          hadError = true;
          console.error(err(`  ${label}: `) + (e instanceof Error ? e.message : String(e)));
        }
      };

      const reportDir = (label: string, fn: () => MigrateDirResult) => {
        try {
          const r = fn();
          if (r.fromDir === null) {
            console.log(dim(`  ${label}: ${r.note ?? "nothing to migrate"} (${r.toDir})`));
          } else if (r.dryRun) {
            console.log(dim(`  ${label}: would move ${r.movedCount ?? 0} entrie(s) from ${r.fromDir} → ${r.toDir}`));
          } else {
            console.log(
              ok(`  ${label}: `) +
                `${r.movedCount ?? 0} entrie(s) ${r.fromDir} → ${r.toDir}` +
                (r.note ? dim(` (${r.note})`) : "")
            );
          }
        } catch (e) {
          hadError = true;
          console.error(err(`  ${label}: `) + (e instanceof Error ? e.message : String(e)));
        }
      };

      report("config.json", () => migrateConfigFile({ dryRun }));
      report("workers.yaml", () => relocateWorkersYaml({ dryRun }));
      report("whisper-rules.md", () => migrateWhisperRules({ dryRun }));
      report("advisor-mode.json", () => migrateAdvisorMode({ dryRun }));
      reportDir("session-state/", () => migrateSessionStateDir({ dryRun }));
      report("session-scan-cache.json", () => migrateSessionScanCache({ dryRun }));
      reportDir("queries/", () => migrateQueriesDir({ dryRun }));
      report("summary-cooldowns.json", () => migrateSummaryCooldowns({ dryRun }));
      report("work-queue.json", () => migrateWorkQueue({ dryRun }));
      report("kg-backfill-state.json", () => migrateKgBackfillState({ dryRun }));
      report("voices.json", () => migrateVoicesJson({ dryRun }));
      report("federation.db (orphan)", () => migrateFederationDbOrphan(dryRun));
      report("registry.db", () => migrateRegistryDb(dryRun));
      report("federation.db (live)", () => migrateFederationDbLive(dryRun));
      reportDir("obsidian-vault/", () => migrateObsidianVaultDir({ dryRun }));
      try {
        const r = migrateObsidianVaultPathConfig(dryRun);
        const label = "obsidian-vault path in config.json";
        switch (r.status) {
          case "not-set":
            console.log(dim(`  ${label}: not set`));
            break;
          case "already-new":
            console.log(dim(`  ${label}: already at new location`));
            break;
          case "custom":
            console.log(dim(`  ${label}: custom, left alone`));
            break;
          case "would-rewrite":
            console.log(dim(`  ${label}: would rewrite ${r.from} → ${r.to}`));
            break;
          case "rewritten":
            console.log(ok(`  ${label}: `) + `${r.from} → ${r.to}`);
            break;
        }
      } catch (e) {
        hadError = true;
        console.error(err("  obsidian-vault path in config.json: ") + (e instanceof Error ? e.message : String(e)));
      }
      report("scheduler-state.json", () => migrateSchedulerState({ dryRun }));
      report("identity.txt", () => migrateIdentityFile({ dryRun }));
      report("registry-scan.json", () => migrateScanConfig({ dryRun }));

      try {
        const r = migrateBackupsLegacy(dryRun);
        if (r.fromDir === null) {
          console.log(dim(`  backups/legacy-pai-backups/: ${r.note ?? "nothing to migrate"} (${r.toDir})`));
        } else if (r.dryRun) {
          console.log(dim(`  backups/legacy-pai-backups/: would copy+verify ${r.fromDir} → ${r.toDir}`));
        } else {
          console.log(
            ok(`  backups/legacy-pai-backups/: `) +
              `${r.filesVerified ?? 0} file(s) verified, ${r.fromDir} → ${r.toDir}` +
              (r.note ? dim(` (${r.note})`) : "")
          );
        }
      } catch (e) {
        hadError = true;
        console.error(err(`  backups/legacy-pai-backups/: `) + (e instanceof Error ? e.message : String(e)));
      }

      const reportContentDir = (label: string, fn: () => MigrateContentDirResult) => {
        try {
          const r = fn();
          if (r.fromDir === null) {
            console.log(dim(`  ${label}: ${r.note ?? "nothing to migrate"} (${r.toDir})`));
          } else if (r.dryRun) {
            console.log(dim(`  ${label}: would move ${r.movedCount ?? 0} entrie(s) from ${r.fromDir} → ${r.toDir}, then symlink`));
          } else {
            const symlinkPart = r.symlinked
              ? ", adapter symlink created"
              : ` — NOT symlinked (${r.symlinkNote ?? "see note"})`;
            console.log(
              ok(`  ${label}: `) +
                `${r.movedCount ?? 0} entrie(s) ${r.fromDir} → ${r.toDir}${symlinkPart}` +
                (r.note ? dim(` (${r.note})`) : "")
            );
          }
        } catch (e) {
          hadError = true;
          console.error(err(`  ${label}: `) + (e instanceof Error ? e.message : String(e)));
        }
      };
      reportContentDir("Agents/", () => migrateAgentsDir({ dryRun }));
      reportContentDir("Commands/", () => migrateCommandsDir({ dryRun }));

      if (opts.logs) {
        try {
          const { workers } = readWorkersSection();
          const oldLogDir = expandHome(workers.logDir);
          const newLogDir = paiHomePath("logs", "workers");
          const r = migrateWorkerLogs(oldLogDir, newLogDir, { dryRun });
          if (r.fromPath === null) {
            console.log(dim(`  logs/workers: ${r.note ?? "nothing to migrate"} (${r.toPath})`));
          } else if (r.dryRun) {
            console.log(dim(`  logs/workers: would move ${r.fromPath} → ${r.toPath}`));
          } else {
            console.log(
              ok(`  logs/workers: `) +
                `${r.filesMoved ?? 0} file(s) ${r.fromPath} → ${r.toPath}` +
                (r.note ? dim(` (${r.note})`) : "")
            );
          }
        } catch (e) {
          hadError = true;
          const msg = e instanceof WorkerLogsMigrationError ? e.message : String(e instanceof Error ? e.message : e);
          console.error(err("  logs/workers: ") + msg);
        }
      } else {
        console.log(dim(`  logs/workers: pass --logs to move it (skipped by default — actively written by running workers)`));
      }

      if (opts.history) {
        try {
          const { workers } = readWorkersSection();
          const active = activeSpawnedWorkerCount(expandHome(workers.logDir));
          if (active > 0 && !dryRun) {
            throw new Error(
              `${active} worker(s) other than the interactive session are RUNNING (see \`pai worker ps\`) — ` +
                `History/ etc. are written by every session's hooks, wait for them to finish and confirm no ` +
                `other interactive \`claude\` session is active, then retry`
            );
          }
          reportDir("History/", () => migrateHistoryDir({ dryRun }));
          report("agent-sessions.json", () => migrateAgentSessions({ dryRun }));
          report("session-routing.json", () => migrateSessionRouting({ dryRun }));
          report("History/security/security-events.jsonl", () => migrateSecurityEvents({ dryRun }));
        } catch (e) {
          hadError = true;
          console.error(err("  History/ etc.: ") + (e instanceof Error ? e.message : String(e)));
        }
      } else {
        console.log(
          dim(`  History/, agent-sessions.json, session-routing.json, security-events.jsonl: pass --history to move (skipped by default — actively written by hooks on every session)`)
        );
      }

      report(".last-housekeeping", () => migrateLastHousekeeping({ dryRun }));

      try {
        const r = migrateSessionStopLock({ dryRun });
        const line = `  .session-stop.lock: ${r.note}`;
        console.log(r.status === "moved" && !dryRun ? ok(line) : dim(line));
      } catch (e) {
        hadError = true;
        console.error(err("  .session-stop.lock: ") + (e instanceof Error ? e.message : String(e)));
      }

      if (hadError) process.exitCode = 1;
    });
}
