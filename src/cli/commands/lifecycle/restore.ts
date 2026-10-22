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

import {
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
  mkdirSync,
  openSync,
  closeSync,
  chmodSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { ok, warn, err, dim, bold } from "../../lib/utils.js";
import { loadConfig, paiConfigFilePath } from "../../../daemon/config.js";
import { inspectStorageBackup, restoreStorageFiles } from "../../../storage/backup.js";
import { backupsDirPath } from "./backup.js";
import { countSql } from "../../../storage/postgres/snapshot.js";
import { assertPgName, isContainerTarget, quoteIdent, type PgTarget } from "../../../storage/postgres/config.js";
import {
  BACKUP_TABLES, RESTORE_DB_MAX_BYTES, configDatabaseMismatch, planPostgresRestore, readBackupMeta, scanDumpFile, validatePgDump,
  type BackupMeta,
} from "./backup-postgres.js";

export { validatePgDump };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_FILE = paiConfigFilePath();
const BACKUPS_DIR = backupsDirPath();
const DOCKER_CONTAINER = "pai-pgvector";

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Copies the current config to a timestamped 0600 file next to it, then installs src. Returns the safety path (null when there was no current config). */
export function restoreConfigWithSafety(src: string, dest: string): string | null {
  mkdirSync(dirname(dest), { recursive: true });
  let safety: string | null = null;
  if (existsSync(dest)) {
    safety = `${dest}.pre-restore-${stampNow()}`;
    for (let i = 1; existsSync(safety); i++) safety = `${dest}.pre-restore-${stampNow()}-${i}`;
    copyFileSync(dest, safety);
    chmodSync(safety, 0o600);
  }
  copyFileSync(src, dest);
  chmodSync(dest, 0o600);
  return safety;
}

export interface PgRunResult { status: number | null; stdout: string; stderr: string }
/** Runs `psql`/`pg_dump`; args are the program and its arguments (connection options excluded). */
export type PgRunner = (args: string[], input?: string | { file: string }, output?: { file: string }) => PgRunResult;

/**
 * Runner for a target: inside the PAI container when the target is the local PAI server,
 * otherwise the host's psql/pg_dump pointed at the server the connection string names.
 */
export function makePgRunner(target: PgTarget): PgRunner {
  return (args, input, output) => {
    const inContainer = isContainerTarget(target);
    const [prog, ...rest] = args;
    const cmd = inContainer ? "docker" : prog!;
    const argv = inContainer
      ? ["exec", ...(input !== undefined ? ["-i"] : []), DOCKER_CONTAINER, ...args]
      : [...(target.host ? ["-h", target.host] : []), ...(target.port ? ["-p", String(target.port)] : []), ...rest];
    // A file input is handed to the child as its stdin fd: the kernel streams it, nothing is read into this process.
    const fd = typeof input === "object" ? openSync(input.file, "r") : undefined;
    // A file output receives the child's stdout directly (0600): a multi-GB dump never becomes a JS string.
    const outFd = output ? openSync(output.file, "w", 0o600) : undefined;
    try {
      const r = spawnSync(cmd, argv, {
        input: typeof input === "string" ? input : undefined,
        encoding: "utf8",
        stdio: [fd ?? "pipe", outFd ?? "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 1024,
        env: target.password !== undefined ? { ...process.env, PGPASSWORD: target.password } : process.env,
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (outFd !== undefined) closeSync(outFd);
    }
  };
}

export interface PgRestoreResult { ok: boolean; message: string; safetyDump?: string; oldDb?: string; counts?: Record<string, { expected: number; actual: number | null }> }

/**
 * Restores a dump without destroying the live database first:
 * validate -> pre-restore dump of live DB -> restore into a NEW database -> swap by rename.
 * Any failure before the swap leaves the live database untouched.
 */
export async function restorePostgres(
  dumpFile: string,
  safetyDir: string,
  target: PgTarget,
  run: PgRunner = makePgRunner(target),
  recordedCounts?: Record<string, number>,
  opts: { noSafetyDump?: boolean } = {},
): Promise<PgRestoreResult> {
  const PG_DATABASE = target.database;
  const PG_USER = target.user;
  try {
    assertPgName(PG_DATABASE, "database", RESTORE_DB_MAX_BYTES);
    assertPgName(PG_USER, "user");
  } catch (e) {
    return { ok: false, message: `${e instanceof Error ? e.message : String(e)}; live database untouched` };
  }
  const { counts: dumpCounts, invalid } = await scanDumpFile(dumpFile);
  if (invalid) return { ok: false, message: `${invalid}; live database untouched` };

  const stamp = stampNow().replace(/[^0-9A-Za-z]/g, "").toLowerCase();
  const newDb = `${PG_DATABASE}_restore_${stamp}`;
  const oldDb = `${PG_DATABASE}_prerestore_${stamp}`;
  const qNew = quoteIdent(newDb);
  const qOld = quoteIdent(oldDb);
  const qLive = quoteIdent(PG_DATABASE);
  const qUser = quoteIdent(PG_USER);
  const firstLine = (r: PgRunResult) => r.stderr.split("\n")[0] || "unknown error";

  // Pre-restore dump of the live DB, written straight to a file. It must succeed and verify, else refuse
  // (unless the caller opted out); a database that does not exist yet has nothing to save.
  let safetyDump: string | undefined;
  if (!opts.noSafetyDump) {
    const path = join(safetyDir, `postgres-pai.pre-restore-${stampNow()}.sql`);
    mkdirSync(safetyDir, { recursive: true });
    const live = run(["pg_dump", "-U", PG_USER, PG_DATABASE], undefined, { file: path });
    if (live.status === 0) {
      const { invalid: safetyInvalid } = await scanDumpFile(path);
      if (safetyInvalid) {
        rmSync(path, { force: true });
        return { ok: false, message: `pre-restore dump of live database is incomplete (${safetyInvalid}); live database untouched (use --no-safety-dump to skip it)` };
      }
      safetyDump = path;
    } else {
      rmSync(path, { force: true });
      if (!/does not exist/.test(live.stderr)) {
        return { ok: false, message: `pre-restore dump failed: ${firstLine(live)}; live database untouched (use --no-safety-dump to skip it)` };
      }
    }
  }

  const cleanup = () => run(["psql", "-U", PG_USER, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${qNew};`]);
  const created = run(["psql", "-U", PG_USER, "-d", "postgres", "-c", `CREATE DATABASE ${qNew} OWNER ${qUser};`]);
  if (created.status !== 0) {
    return { ok: false, message: `could not create staging database: ${firstLine(created)}; live database untouched`, safetyDump };
  }

  const loaded = run(["psql", "-U", PG_USER, "-v", "ON_ERROR_STOP=1", "-d", newDb], { file: dumpFile });
  if (loaded.status !== 0) {
    cleanup();
    return { ok: false, message: `psql failed: ${firstLine(loaded)}; live database untouched`, safetyDump };
  }

  // Swap: live -> old, staging -> live. Old is kept as an extra way back.
  const swap1 = run(["psql", "-U", PG_USER, "-d", "postgres", "-c", `ALTER DATABASE ${qLive} RENAME TO ${qOld};`]);
  const liveExisted = swap1.status === 0;
  if (!liveExisted && !/does not exist/.test(swap1.stderr)) {
    cleanup();
    return { ok: false, message: `could not rename live database (active connections? stop the daemon): ${firstLine(swap1)}; live database untouched`, safetyDump };
  }
  const swap2 = run(["psql", "-U", PG_USER, "-d", "postgres", "-c", `ALTER DATABASE ${qNew} RENAME TO ${qLive};`]);
  if (swap2.status !== 0) {
    if (liveExisted) run(["psql", "-U", PG_USER, "-d", "postgres", "-c", `ALTER DATABASE ${qOld} RENAME TO ${qLive};`]);
    cleanup();
    return { ok: false, message: `swap failed: ${firstLine(swap2)}; live database restored`, safetyDump };
  }
  const oldDbKept = liveExisted ? oldDb : undefined;

  // Verify the main tables against the dump's recorded counts.
  const expected = recordedCounts ?? Object.fromEntries(dumpCounts);
  const counts: NonNullable<PgRestoreResult["counts"]> = {};
  const bad: string[] = [];
  for (const table of BACKUP_TABLES) {
    if (!(table in expected)) continue;
    const r = run(["psql", "-U", PG_USER, "-d", PG_DATABASE, "-tAc", countSql(table)]);
    const actual = r.status === 0 ? Number(r.stdout.trim()) : null;
    counts[table] = { expected: expected[table]!, actual };
    if (actual !== expected[table]) bad.push(`${table}: expected ${expected[table]}, got ${actual ?? "n/a"}`);
  }
  if (bad.length > 0) {
    return { ok: false, message: `restored into "${PG_DATABASE}" but row counts differ (${bad.join("; ")})`, safetyDump, oldDb: oldDbKept, counts };
  }
  return { ok: true, message: "restored", safetyDump, oldDb: oldDbKept, counts };
}

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

export async function runRestore(backupPath: string | undefined, opts: { postgres: boolean; yes: boolean; dryRun?: boolean; into?: string; noSafetyDump?: boolean }): Promise<void> {

  // ------------------------------------------------------------------
  // 1. Determine backup directory
  // ------------------------------------------------------------------

  let resolvedDir: string;

  if (backupPath) {
    resolvedDir = backupPath.startsWith("~")
      ? backupPath.replace(/^~/, homedir())
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

  // Postgres target: same resolver as backup and the running storage.
  const meta: BackupMeta | null = readBackupMeta(resolvedDir);
  const plan = planPostgresRestore(loadConfig().postgres, meta, opts.into);
  if (hasSql && opts.postgres) {
    console.log(`\n${bold("Postgres:")}`);
    console.log(`  Target database      ${plan.target.database} (user ${plan.target.user})`);
    console.log(`  Dump source database ${plan.source ?? "unknown"}`);
    if (plan.refusal) {
      console.error(err(`Refusing to restore: ${plan.refusal}`));
      if (!opts.dryRun) {
        process.exitCode = 1;
        return;
      }
    }
  }
  if (opts.dryRun) {
    console.log(dim("\nDry run: nothing was changed."));
    return;
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
      const safety = restoreConfigWithSafety(join(resolvedDir, "config.json"), CONFIG_FILE);
      if (safety) console.log(dim(`  Previous config.json saved to ${safety}`));
      results.push({ label: "Config", status: ok("restored") });
      if (hasSql && opts.postgres) {
        const mismatch = configDatabaseMismatch(join(resolvedDir, "config.json"), plan.target);
        if (mismatch) console.log(warn(`  ${mismatch}`));
      }
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
      if (isContainerTarget(plan.target)) {
        execFileSync("docker", ["inspect", DOCKER_CONTAINER, "--format={{.State.Status}}"], {
          stdio: "pipe",
        });
      }

      const pg = await restorePostgres(join(resolvedDir, "postgres-pai.sql"), dirname(CONFIG_FILE), plan.target, undefined, meta?.counts, { noSafetyDump: opts.noSafetyDump });
      if (pg.safetyDump) console.log(dim(`  Pre-restore dump of live database: ${pg.safetyDump}`));
      if (pg.oldDb) console.log(dim(`  Previous database kept as '${pg.oldDb}' (drop it when satisfied)`));
      for (const [t, c] of Object.entries(pg.counts ?? {})) {
        console.log(dim(`  ${t}: expected ${c.expected}, restored ${c.actual ?? "n/a"}`));
      }
      results.push({ label: "Postgres DB", status: pg.ok ? ok("restored") : err(`failed: ${pg.message}`) });
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      results.push({ label: "Postgres DB", status: err(`failed: ${msg}`) });
      if (isContainerTarget(plan.target)) console.log(warn(`  Is Docker running with container '${DOCKER_CONTAINER}'?`));
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
}
