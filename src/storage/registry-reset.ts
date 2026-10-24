/**
 * registry-reset.ts — what every registry reset leaves behind.
 *
 * 2026-10-24 the projects table was emptied and refilled with new ids by an
 * unknown caller; 2.79M chunks were orphaned and nothing said who did it. A
 * reset now keeps a backup of `projects`, and one log line names the process.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { paiHomeDir } from "../config/pai-home.js";

/** Backups of `projects` kept; older ones are dropped at the next reset. */
export const PROJECT_BACKUPS_KEEP = 3;

const BACKUP_RE = /^projects_backup_(\d+)$/;

export function backupTableName(epochMs: number): string {
  return `projects_backup_${epochMs}`;
}

/** Backup table names among `names`, newest first; anything else is ignored. */
export function sortBackups(names: string[]): string[] {
  return names
    .filter((n) => BACKUP_RE.test(n))
    .sort((a, b) => Number(b.match(BACKUP_RE)![1]) - Number(a.match(BACKUP_RE)![1]));
}

/** The backups to drop so that only `keep` remain. */
export function backupsToPrune(names: string[], keep = PROJECT_BACKUPS_KEEP): string[] {
  return sortBackups(names).slice(keep);
}

function parentCommand(ppid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(ppid)], { encoding: "utf-8", timeout: 2000 }).trim() || "?";
  } catch {
    return "?";
  }
}

/** "by=<pid> cmd=<argv> cwd=<cwd> parent=<ppid cmd>": who is resetting. */
export function callerInfo(): string {
  return `by=${process.pid} cmd=${process.argv.join(" ")} cwd=${process.cwd()} parent=${process.ppid} ${parentCommand(process.ppid)}`;
}

export function resetLogPath(): string {
  return join(paiHomeDir(), "logs", "registry-reset.log");
}

/** Write the REGISTRY-RESET line to stderr (the daemon log when run there) and to logs/registry-reset.log. */
export function logRegistryReset(detail: string): string {
  const line = `REGISTRY-RESET ${callerInfo()} ${detail}`;
  process.stderr.write(`[pai-registry] ${line}\n`);
  try {
    mkdirSync(join(paiHomeDir(), "logs"), { recursive: true });
    appendFileSync(resetLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the stderr line stands
  }
  return line;
}
