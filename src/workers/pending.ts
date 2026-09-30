/**
 * Pending worker results: finished workers whose worktree branch still holds
 * work that never reached the repo (commits not in HEAD, or uncommitted
 * files). Surfaced by `pai worker ps/pending`, the SessionStart hook, the
 * status line and the prepublish gate so an unmerged fix cannot be forgotten.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLive, loadStatuses } from "./status.js";
import { statusPath } from "./paths.js";
import { git, uncommittedPaths } from "./worktree.js";

export interface PendingResult {
  id: string;
  label: string;
  repo: string;
  /** ms since the worker's status file last changed (its end). */
  ageMs: number;
  age: string;
  /** commits on the branch not in the repo's HEAD (patch-id aware). */
  commits: number;
  /** uncommitted paths in the worktree, node_modules excluded. */
  dirty: number;
}

/** Stale after this long: `pai worker gc` (archive) instead of merge. */
export const STALE_HOURS = 24;

function toplevel(dir: string): string | null {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

function fmtAge(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.floor(ms / 60_000)}m`;
}

/** Finished workers with unmerged work; `repoRoot` limits to one repo, else every repo. */
export function pendingResults(logDir: string, repoRoot?: string, now = Date.now()): PendingResult[] {
  const want = repoRoot ? toplevel(repoRoot) : null;
  if (repoRoot && !want) return [];
  const out: PendingResult[] = [];
  for (const st of loadStatuses(logDir)) {
    if (st.archived || st.merged || isLive(st)) continue;
    if (!st.worktreeDir || !existsSync(st.worktreeDir)) continue;
    const repo = toplevel(st.cwd);
    if (!repo || (want && repo !== want)) continue;
    let commits = 0;
    let dirty = 0;
    try {
      if (st.branch) {
        commits = git(repo, ["cherry", "HEAD", `refs/heads/${st.branch}`])
          .split("\n")
          .filter((l) => l.startsWith("+")).length;
      }
      dirty = uncommittedPaths(st.worktreeDir).filter((p) => !/(^|\/)node_modules(\/|$)/.test(p)).length;
    } catch {
      continue; // branch or worktree unreadable: nothing verifiable to report
    }
    if (!commits && !dirty) continue;
    let ageMs = 0;
    try {
      ageMs = Math.max(0, now - statSync(statusPath(logDir, st.id)).mtimeMs);
    } catch {
      // status vanished mid-scan: age unknown, keep the entry
    }
    out.push({ id: st.id, label: st.label, repo, ageMs, age: fmtAge(ageMs), commits, dirty });
  }
  return out;
}

/** One human line per result, with the exact next command. */
export function formatPending(results: PendingResult[], showRepo = false): string {
  return results
    .map((r) => {
      const next = r.ageMs > STALE_HOURS * 3_600_000 ? "pai worker gc" : `pai worker merge ${r.id}`;
      const repo = showRepo ? `  ${r.repo}` : "";
      return `${r.id}  ${r.age}  ${r.commits} commit(s), ${r.dirty} dirty  ${r.label}${repo}  -> ${next}`;
    })
    .join("\n");
}

/**
 * Release gate: exit code and message for `pai worker pending --gate`.
 * PAI_ALLOW_PENDING=1 overrides.
 */
export function pendingGate(
  results: PendingResult[],
  env: NodeJS.ProcessEnv = process.env
): { code: number; message: string } {
  if (!results.length || env.PAI_ALLOW_PENDING === "1") return { code: 0, message: "" };
  return {
    code: 1,
    message:
      `${results.length} unmerged worker result(s) in this repo — merge or discard before publishing:\n` +
      `${formatPending(results)}\n` +
      "Override deliberately with PAI_ALLOW_PENDING=1.",
  };
}

/** Cached count of pending results for `cwd`'s repo (statusline/hook: cheap on repeat). */
export function pendingCountCached(logDir: string, cwd: string, ttlMs = 60_000, now = Date.now()): number {
  const file = join(logDir, "pending-cache.json");
  let cache: Record<string, { at: number; n: number }> = {};
  try {
    cache = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // no cache yet
  }
  const hit = cache[cwd];
  if (hit && now - hit.at < ttlMs) return hit.n;
  const n = pendingResults(logDir, cwd, now).length;
  try {
    writeFileSync(file, JSON.stringify({ ...cache, [cwd]: { at: now, n } }));
  } catch {
    // read-only log dir: recompute next time
  }
  return n;
}

/** Invalidate pending cache entries for a repo and its subdirectories. */
export function invalidatePendingCache(logDir: string, repoRoot: string): void {
  const file = join(logDir, "pending-cache.json");
  let cache: Record<string, { at: number; n: number }> = {};
  try {
    cache = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // no cache yet
    return;
  }
  const resolved = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (key === repoRoot || key.startsWith(resolved)) {
      delete cache[key];
      changed = true;
    }
  }
  if (!changed) return;
  try {
    writeFileSync(file, JSON.stringify(cache));
  } catch {
    // read-only log dir: best effort
  }
}
