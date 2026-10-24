/**
 * gc-run.ts — `pai worker gc`: the one implementation behind the CLI verb and
 * the worker_gc MCP tool. Prints through `out`, returns nothing.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { endProcesses, findWorktreeOrphans } from "./reap.js";
import { gcSettingsFiles } from "./settings-file.js";
import { formatKnowledge, gcPoolWorktrees, gcWorktrees, isPoolHostCmd } from "./worktree.js";

export interface WorkerGcOptions {
  /** Minimum age of a finished worker in hours (default 24). */
  olderThanHours?: number;
  allFinished?: boolean;
  pool?: boolean;
  /** Also archive merged, clean worktrees of the repo at `repo` that PAI did not create. */
  foreign?: boolean;
  /** The repo `foreign` applies to (the CLI passes its cwd). */
  repo?: string;
  killOrphans?: boolean;
  dryRun?: boolean;
}

export async function runWorkerGc(logDir: string, o: WorkerGcOptions, out: (s: string) => void): Promise<void> {
  const hours = o.olderThanHours ?? 24;
  if (!Number.isFinite(hours) || hours < 0) throw new Error(`bad older-than "${hours}"`);
  const dryRun = o.dryRun === true;
  const orphans = findWorktreeOrphans(logDir);
  // a process in a spare-<hostPid>-N tree whose host pid is alive and runs worker-pool-host
  // is that host's spare, not an orphan (the pid's command is checked against pid reuse);
  // spares of a dead or reused host stay orphans
  const hostCmd = (pid: number): string => {
    try {
      return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const hostAlive = new Map<number, boolean>();
  const isPoolSpare = (dir: string, cmd: string): boolean => {
    const m = /^spare-(\d+)-\d+$/.exec(basename(dir));
    if (!m) return false;
    const hostPid = Number(m[1]);
    let alive = hostAlive.get(hostPid);
    if (alive === undefined) {
      alive = false;
      try {
        process.kill(hostPid, 0);
        alive = isPoolHostCmd(hostCmd(hostPid));
      } catch {
        /* pid gone */
      }
      hostAlive.set(hostPid, alive);
    }
    // the spare's own claude, or a headless worker started in it; anything else (a shell) is fair game
    return alive && /(^|\/)claude(\s|$)/.test(cmd);
  };
  const listed = orphans.filter((x) => !isPoolSpare(x.dir, x.cmd));
  for (const x of listed) out(`orphan pid ${x.pid} in ${x.dir}: ${x.cmd.slice(0, 200)}`);
  if (listed.length && o.killOrphans && !dryRun) await endProcesses(listed, out);
  const res = gcWorktrees(logDir, o.allFinished ? 0 : hours, dryRun, Date.now(), true, undefined, o.foreign ? o.repo ?? process.cwd() : undefined);
  if (o.pool || o.allFinished) res.push(...gcPoolWorktrees(logDir, dryRun));
  for (const f of gcSettingsFiles(logDir, dryRun)) out(`${dryRun ? "would remove" : "removed"} settings file ${f}`);
  const verb = dryRun ? "would archive" : "archived";
  for (const r of res) {
    out(
      r.branch
        ? r.skipped
          ? `branch ${r.id} [${r.repoName}]: ${r.skipped}`
          : `${dryRun ? "would delete" : "deleted"} branch ${r.id} [${r.repoName}] (archive ${r.archive})`
        : r.skipped
          ? `skipped ${r.id}: ${r.skipped}`
          : `${verb} ${r.id} -> ${r.archive}`
    );
    if (r.adopted) out(`  adopted detached HEAD ${r.adopted.slice(0, 7)}`);
    if (dryRun && r.knowledge) {
      const k = formatKnowledge(r.knowledge);
      for (const l of k.length ? k : ["carries nothing"]) out(`  ${l}`);
    }
  }
  const done = res.filter((r) => r.archive);
  const kept = res.filter((r) => r.skipped);
  const files = done.reduce((n, r) => n + (r.salvaged?.filter((l) => l.startsWith("salvaged ")).length ?? 0), 0);
  out(
    `${done.length} ${dryRun ? "would be archived" : "archived"}, salvaged ${files} file(s), kept ${kept.length}` +
      (kept.length ? ` (${kept.map((r) => `${r.id}${r.repoName ? ` [${r.repoName}]` : ""}: ${r.skipped}`).join("; ")})` : "")
  );
}
