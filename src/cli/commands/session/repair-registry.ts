/**
 * pai session repair-registry — point registry rows at the note file they belong to.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../daemon/config.js";
import { isContainerTarget } from "../../../storage/postgres/config.js";
import { resolveBackupTarget, validatePgDump } from "../lifecycle/backup-postgres.js";
import { getRegistryBackend } from "../../../storage/factory.js";
import { drainRenameQueue, repairProject, type RepairOutcome } from "../../../storage/session-note-registry.js";
import { findAllNotesDirs } from "../session-cleanup/scanner.js";
import { ok, warn, dim } from "../../lib/utils.js";

/** pg_dump of the sessions table alone (a whole-database dump takes far longer than this repair). Throws on failure. */
export function backupSessionsTable(): string {
  const target = resolveBackupTarget(loadConfig().postgres);
  const dir = join(homedir(), ".cache", "pai", "backups");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `sessions-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`);
  const fd = openSync(dest, "w");
  try {
    const args = ["-U", target.user, "-t", "sessions"];
    const r = isContainerTarget(target)
      ? spawnSync("docker", ["exec", "pai-pgvector", "pg_dump", ...args, target.database], { stdio: ["ignore", fd, "pipe"] })
      : spawnSync("pg_dump", ["-h", target.host!, "-p", String(target.port), ...args, "-d", target.database], {
          stdio: ["ignore", fd, "pipe"],
          env: target.password !== undefined ? { ...process.env, PGPASSWORD: target.password } : process.env,
        });
    if (r.error || r.status !== 0) throw new Error(`sessions backup failed: ${r.error ?? r.stderr?.toString().trim()}`);
  } catch (e) {
    unlinkSync(dest);
    throw e;
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(dest, "utf8");
  if (validatePgDump(text) || !text.includes("COPY public.sessions")) {
    unlinkSync(dest);
    throw new Error("sessions backup failed verification");
  }
  return dest;
}

export async function cmdRepairRegistry(opts: { project?: string; all?: boolean; dryRun?: boolean }): Promise<void> {
  if (!opts.project && !opts.all) throw new Error("give --project <slug> or --all");
  const backend = await getRegistryBackend();
  const projects = opts.all
    ? await backend.listProjects()
    : [(await backend.getProjectBySlug(opts.project!)) ?? (await backend.getProjectBySlug(opts.project!, { caseInsensitive: true }))];
  if (projects.some((p) => !p)) throw new Error(`Project not found: ${opts.project}`);

  if (!opts.dryRun) {
    console.log(dim(`  Sessions table backed up to ${backupSessionsTable()}`));
    const q = await drainRenameQueue(async () => backend);
    console.log(dim(`  Rename queue: ${q.applied} applied, ${q.kept} kept, ${q.dropped} dropped`));
  }

  const total: RepairOutcome = { project: "TOTAL", rows: 0, resolved: 0, fixed: 0, ambiguous: 0, unmatched: 0 };
  for (const p of projects) {
    const r = await repairProject(backend, p!, findAllNotesDirs(p as never), opts.dryRun === true);
    if (r.rows === 0) continue;
    console.log(`  ${r.project}: rows ${r.rows}, already ok ${r.resolved}, ${opts.dryRun ? "would fix" : "fixed"} ${r.fixed}, ambiguous ${r.ambiguous}, unmatched ${r.unmatched}`);
    for (const k of ["rows", "resolved", "fixed", "ambiguous", "unmatched"] as const) total[k] += r[k];
  }
  console.log(`  ${total.project}: rows ${total.rows}, already ok ${total.resolved}, ${opts.dryRun ? "would fix" : "fixed"} ${total.fixed}, ambiguous ${total.ambiguous}, unmatched ${total.unmatched}`);
  console.log(opts.dryRun ? warn("  Dry run: nothing changed.") : ok("  Registry updated; no rows deleted."));
}
