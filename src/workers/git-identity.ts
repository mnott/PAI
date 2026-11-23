/**
 * git-identity.ts — backstop for a worker that rewrites the shared repo identity.
 *
 * A linked worktree shares the main repo's .git/config, so a worker's script
 * that runs `git config user.name/user.email` there (a bench script did, after
 * `git worktree add --detach`) changes the identity of every later commit on
 * main. The Bash guard cannot see a script's own subprocesses. Every worker
 * passes through addWorktree (baseline recorded) and mergeWorker (compared),
 * so the check lives there: a changed value is restored and logged with the id.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitIdentity { name: string | null; email: string | null }

const KEYS = [["name", "user.name"], ["email", "user.email"]] as const;

function cfg(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "config", "--local", ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null; // unset (exit 1) or not a repo
  }
}

export function readGitIdentity(cwd: string): GitIdentity {
  return { name: cfg(cwd, ["--get", "user.name"]), email: cfg(cwd, ["--get", "user.email"]) };
}

const baselinePath = (logDir: string, id: string): string => join(logDir, "git-identity", `${id}.json`);

export function recordGitIdentity(logDir: string, id: string, cwd: string): void {
  try {
    const p = baselinePath(logDir, id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(readGitIdentity(cwd)));
  } catch {
    // best effort: no baseline, no check
  }
}

/** Restore the repo identity to the worker's start baseline; returns the notice line, or null when unchanged. */
export function restoreGitIdentity(logDir: string, id: string, cwd: string): string | null {
  const p = baselinePath(logDir, id);
  if (!existsSync(p) || !existsSync(cwd)) return null;
  let base: GitIdentity;
  try { base = JSON.parse(readFileSync(p, "utf8")) as GitIdentity; } catch { return null; }
  const now = readGitIdentity(cwd);
  const changed: string[] = [];
  for (const [field, key] of KEYS) {
    if (now[field] === base[field]) continue;
    if (base[field] === null) cfg(cwd, ["--unset", key]);
    else cfg(cwd, [key, base[field]!]);
    changed.push(`${key} ${now[field] ?? "(unset)"} -> ${base[field] ?? "(unset)"}`);
  }
  if (!changed.length) return null;
  const line = `worker ${id}: changed the shared git identity of ${cwd} (${changed.join("; ")}); restored`;
  try { appendFileSync(join(logDir, "git-identity", "alerts.log"), `${new Date().toISOString()} ${line}\n`); } catch { /* log is best effort */ }
  console.error(`WARNING ${line}`);
  return line;
}
