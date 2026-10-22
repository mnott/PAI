/**
 * `pai config` — the PAI_HOME namespace dir (~/.pai by default) and
 * moving the per-user files that live under it: config.json, workers.yaml,
 * whisper-rules.md, advisor-mode.json, session-state/, and the remaining
 * per-subsystem state files/dirs migrated from ~/.config/pai on 2026-09-19
 * (session-scan-cache.json, queries/, summary-cooldowns.json,
 * work-queue.json, kg-backfill-state.json, voices.json, the orphaned legacy
 * federation database), plus the legacy registry database file and the two
 * content dirs that get an adapter symlink back to ~/.claude, `agents/` and
 * `commands/`. History/, agent-sessions.json, session-routing.json and
 * security-events.jsonl move only with `--history`; logs/workers only with
 * `--logs` — both are written by hooks on every live session and are
 * refused while a worker is RUNNING.
 */

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
import { paiConfigFilePath, paiConfigYamlFilePath, migrateConfigFile } from "../../daemon/config.js";
import { liveWorkersConfigShadows } from "../../workers/config-shadow.js";
import { migrateMainConfigToYaml, MainConfigError } from "../../config/main-config.js";
import { voicesJsonPath, voicesYamlPath, migrateVoicesToYaml } from "../../config/voices-config.js";
import {
  listConfigOp,
  getConfigValueOp,
  setConfigValueOp,
  unsetConfigValueOp,
  formatConfigGetOutput,
  formatConfigSource,
  MainConfigOpsError,
} from "../../config/main-config-ops.js";
import { workersYamlPath, relocateWorkersYaml } from "../../workers/workers-config.js";
import {
  legacyDbDisplayPaths,
  migrateFederationDbOrphan,
  migrateRegistryDbFile,
  migrateFederationDbFile,
} from "../../storage/sqlite/legacy-migration.js";
import { STATE_FILE as schedulerStatePath, migrateSchedulerState } from "../../tasks/poller.js";
import { migrateIdentityFile } from "../../memory/wakeup.js";
import { migrateScanConfig } from "./registry/scan.js";
import { oldBackupsDir, backupsDirPath } from "../commands/lifecycle/backup.js";
import { defaultVaultPath, oldDefaultVaultPath, migrateObsidianVaultDir } from "../../obsidian/sync/generate.js";
import { getConfigObsidianVaultPathRaw, saveVaultPath as saveObsidianVaultPath } from "../lib/obsidian.js";
import { migrateAgentsDir, migrateCommandsDir, type MigrateContentDirResult } from "../../config/adapter-content.js";
import {
  whisperRulesPath,
  advisorModePath,
  sessionStateDir,
  migrateWhisperRules,
  migrateAdvisorMode,
  migrateSessionStateDir,
  migrateVoicesJson,
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
import { ok, err, dim, bold } from "../lib/utils.js";

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
 * ~/.pai/backups/ — pre-PAI_HOME `pai backup` snapshots (registry database,
 * config.json, federation database, postgres-pai.sql per timestamped run).
 * Moved into PAI_HOME/backups/legacy-pai-backups/ rather than merged into
 * PAI_HOME/backups/ directly, since that directory now holds newly created
 * backups going forward and the legacy runs are kept as a clearly-labelled
 * historical archive. Unlike migratePaiDir's plain rename-per-entry, this
 * copies the whole tree then verifies every file byte-identical (sha256)
 * before renaming the old dir aside — these snapshots include a 1.4GB
 * federation database and a 1GB pg_dump, worth the extra care.
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

export function configPathCmd(): number {
  console.log(bold("PAI_HOME: ") + paiHomeDir());
  console.log(`  config.json / config.yaml: ${paiConfigFilePath()} / ${paiConfigYamlFilePath()}`);
  console.log(`  workers.yaml:             ${workersYamlPath()}`);
  console.log(`  whisper-rules.md:         ${whisperRulesPath()}`);
  console.log(`  advisor-mode.json:        ${advisorModePath()}`);
  console.log(`  session-state/:           ${sessionStateDir()}`);
  console.log(`  session-scan-cache.json:  ${scanCacheFilePath()}`);
  console.log(`  queries/:                 ${queriesDirPath()}`);
  console.log(`  summary-cooldowns.json, work-queue.json, kg-backfill-state.json:`);
  console.log(`                            all under PAI_HOME`);
  console.log(`  voices.json / voices.yaml: ${voicesJsonPath()} / ${voicesYamlPath()}`);
  console.log(`  federation database (orphan): under PAI_HOME`);
  console.log(`  logs/workers/:            ${paiHomePath("logs", "workers")} (pass --logs to move)`);
  console.log(`  History/:                 ${paiHomePath("History")} (pass --history to move)`);
  console.log(`  agent-sessions.json, session-routing.json, History/security/security-events.jsonl:`);
  console.log(`                            all under PAI_HOME (pass --history to move)`);
  console.log(`  registry database:        ${legacyDbDisplayPaths().registryDb}`);
  console.log(`  federation database:      ${legacyDbDisplayPaths().federationDb}`);
  console.log(`  backups/:                 ${backupsDirPath()}`);
  console.log(`  obsidian-vault/:          ${defaultVaultPath()}`);
  console.log(`  scheduler-state.json:     ${schedulerStatePath}`);
  console.log(`  identity.txt:             ${paiHomePath("identity.txt")} (L0 wake-up identity, optional)`);
  console.log(`  registry-scan.json:       ${paiHomePath("registry-scan.json")}`);
  console.log(`  agents/:                  ${paiHomePath("agents")} (~/.claude/agents symlinks here after migrate)`);
  console.log(`  commands/:                ${paiHomePath("commands")} (~/.claude/commands symlinks here after migrate)`);
  return 0;
}

export function configYamlCmd(opts: { dryRun?: boolean; force?: boolean }): number {
  let hadError = false;
  const run = (label: string, fn: () => ReturnType<typeof migrateMainConfigToYaml>) => {
    try {
      const r = fn();
      if (r.dryRun) {
        console.log(dim(`  ${label}: would write ${r.yamlPath}`));
      } else {
        console.log(ok(`  ${label}: `) + `${r.backupPath} → ${r.yamlPath}`);
      }
    } catch (e) {
      hadError = true;
      console.error(err(`  ${label}: `) + (e instanceof MainConfigError ? e.message : String(e instanceof Error ? e.message : e)));
    }
  };
  run("config.yaml", () => migrateMainConfigToYaml(paiConfigFilePath(), { dryRun: opts.dryRun, force: opts.force }));
  run("voices.yaml", () => migrateVoicesToYaml({ dryRun: opts.dryRun, force: opts.force }));
  return hadError ? 1 : 0;
}

export function configListCmd(opts: { all?: boolean; json?: boolean }): number {
  const r = listConfigOp({ all: opts.all });
  console.log(opts.json ? JSON.stringify(r.data, null, 2) : r.yaml.trimEnd());
  return 0;
}

/** `pai config validate`: shadowed and unused workers keys across config.yaml and workers.yaml (warnings; exit 0). */
export function configValidateCmd(): number {
  const shadows = liveWorkersConfigShadows();
  if (!shadows.length) {
    console.log(ok("config.yaml and workers.yaml: no shadowed or unused keys"));
    return 0;
  }
  for (const s of shadows) console.log(`warning: ${s.message}`);
  return 0;
}

export function configGetCmd(path: string, opts: { json?: boolean; source?: boolean }): number {
  try {
    const r = getConfigValueOp(path);
    if (!r.found) {
      console.error(err(`Not set: ${path}`));
      return 1;
    }
    console.log(formatConfigGetOutput(r.value, { json: opts.json }));
    if (opts.source) console.log(dim(`  source: ${formatConfigSource(r.source)}`));
  } catch (e) {
    console.error(err((e instanceof MainConfigOpsError ? e.message : String(e instanceof Error ? e.message : e))));
    return 1;
  }
  return 0;
}

export function configSetCmd(path: string, value: string, opts: { force?: boolean }): number {
  try {
    const r = setConfigValueOp(path, value, { force: opts.force });
    if (r.yamlCreated) console.log(dim(`  created ${r.yamlPath}`));
    console.log(ok(`Set ${path} = `) + (typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value)));
  } catch (e) {
    console.error(err((e instanceof MainConfigOpsError || e instanceof MainConfigError ? e.message : String(e instanceof Error ? e.message : e))));
    return 1;
  }
  return 0;
}

export function configUnsetCmd(path: string): number {
  try {
    const r = unsetConfigValueOp(path);
    console.log(r.existed ? ok(`Unset ${path}`) : dim(`  ${path} was not set`));
  } catch (e) {
    console.error(err((e instanceof MainConfigOpsError ? e.message : String(e instanceof Error ? e.message : e))));
    return 1;
  }
  return 0;
}

export function configMigrateCmd(opts: { dryRun?: boolean; logs?: boolean; history?: boolean }): number {
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
  report("federation database (orphan)", () => migrateFederationDbOrphan(dryRun));
  report("registry database", () => migrateRegistryDbFile(dryRun));
  report("federation database (live)", () => migrateFederationDbFile(dryRun));
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
  reportContentDir("agents/", () => migrateAgentsDir({ dryRun }));
  reportContentDir("commands/", () => migrateCommandsDir({ dryRun }));

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

  return hadError ? 1 : 0;
}
