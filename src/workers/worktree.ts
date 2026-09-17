/**
 * worktree.ts — one git worktree per writing worker.
 *
 * A run whose class edits files (implement, complex, plan) and whose cwd is a
 * git repository gets its own worktree by default: `git worktree add
 * <logDir>/worktrees/<id> -b worker/<id>` from the current HEAD. The worker
 * commits its own work on that branch — the no-commit rule applies to the
 * main branch only — and the parent (or the operator) merges the result back:
 *
 *   pai worker merge <id>     git merge --no-ff worker/<id> + remove worktree + delete branch
 *   pai worker discard <id>   remove worktree and branch, keep nothing
 *
 * `ps` marks a worker with an unmerged branch `⎇`. Draft and review run in
 * place; `--no-worktree` opts out, `--worktree` forces one on.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

export function worktreesDir(logDir: string): string {
  return join(logDir, "worktrees");
}

export function worktreeBranch(id: string): string {
  return `worker/${id}`;
}

export function worktreePath(logDir: string, id: string): string {
  return join(worktreesDir(logDir), id);
}

/** Run git in `cwd`, returning trimmed stdout; throws with stderr on failure. */
export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const why =
      (typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8")) ||
      err.message ||
      String(e);
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${why.trim()}`);
  }
}

/** Is `cwd` inside a git repository (a .git dir — worktrees: a .git file)? */
export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--git-dir"]) !== "";
  } catch {
    return false;
  }
}

/**
 * Does the prompt read as a read-only task? Writing classes default to a
 * worktree; a prompt that only asks to look at things should not pay for one.
 * First-word verbs plus the explicit markers people actually write.
 */
export function promptLooksReadonly(prompt: string): boolean {
  const p = prompt.trim();
  if (!p) return true;
  if (/\b(read[- ]only|do not (modify|change|edit|write)|don'?t (modify|change|edit|write)|no changes)\b/i.test(p)) {
    return true;
  }
  return /^(review|read|analy[sz]e|research|summar[iy]|inspect|investigate|spotcheck|report|find|list|check|verify|describe|explain|show)\b/i.test(
    p
  );
}

/** The classes whose runs write files and therefore default to a worktree. */
export const WORKTREE_CLASSES = ["implement", "complex", "plan"] as const;

/** How the run flags decide the worktree question; undefined = decide by default. */
export type WorktreeFlag = boolean | undefined;

/** Should this run get a worktree? Explicit flag first, then the default rule. */
export function worktreeWanted(
  flag: WorktreeFlag,
  opts: { cwd: string; className?: string; prompt: string | null }
): boolean {
  if (flag !== undefined) return flag;
  if (!opts.className || !(WORKTREE_CLASSES as readonly string[]).includes(opts.className)) {
    return false;
  }
  if (!isGitRepo(opts.cwd)) return false;
  return !promptLooksReadonly(opts.prompt ?? "");
}

export interface WorktreeInfo {
  dir: string;
  branch: string;
  base: string;
}

/**
 * Create the worktree and branch for `id` from `cwd`'s HEAD. Throws when git
 * refuses (no commits yet, branch exists, …) — the caller decides whether to
 * degrade to an in-place run.
 */
export function addWorktree(logDir: string, id: string, cwd: string): WorktreeInfo {
  const dir = worktreePath(logDir, id);
  const branch = worktreeBranch(id);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["worktree", "add", dir, "-b", branch]);
  return { dir, branch, base };
}

/** Commits the branch collected on top of its base. */
export function commitsSince(dir: string, base: string): number {
  try {
    return parseInt(git(dir, ["rev-list", "--count", `${base}..HEAD`]), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Record the worktree result in the status file: branch and commit count on
 * success, the worktree cleaned up on failure. Returns the updated status.
 */
export function recordWorktree(
  logDir: string,
  status: WorkerStatus,
  info: WorktreeInfo,
  ok: boolean
): WorkerStatus {
  const s = { ...status };
  if (ok) {
    s.branch = info.branch;
    s.commits = commitsSince(info.dir, info.base);
    s.worktreeDir = info.dir;
    s.worktreeBase = info.base;
  } else {
    // a failed run leaves nothing to merge; the branch dies with the worktree
    removeWorktree(s.cwd, info.dir, true);
    try {
      git(s.cwd, ["branch", "-D", info.branch]);
    } catch {
      // already gone or never created
    }
    s.branch = null;
    s.worktreeDir = null;
    s.worktreeBase = null;
    s.commits = null;
  }
  saveStatus(logDir, s);
  return s;
}

/** Remove a worktree directory from git's books and the filesystem. */
function removeWorktree(cwd: string, dir: string, force: boolean): void {
  try {
    git(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), dir]);
    return;
  } catch {
    // fall through to the manual cleanup
  }
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      git(cwd, ["worktree", "prune"]);
    } catch {
      // best effort: a leftover directory is visible in the logDir
    }
  }
}

/**
 * Carry a worktree's uncommitted changes over to `cwd` before the worktree is
 * removed. `git merge` only moves committed work, so a worker that stopped
 * without committing would otherwise lose its edits to `worktree remove` —
 * exactly what happened live on 2026-09-17. Tracked edits (staged or not)
 * travel as a binary patch applied in `cwd`; untracked files are copied.
 * Returns the carried paths. On any conflict it throws with the worktree
 * still in place, so the operator decides instead of data being lost.
 */
export function carryUncommitted(wtDir: string, cwd: string): string[] {
  // name-only, not porcelain: a worktree-only change renders as " M path" and
  // the shared git() helper trims that leading space away
  const tracked = git(wtDir, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const untracked = git(wtDir, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  if (!tracked.length && !untracked.length) return [];

  if (tracked.length) {
    // raw buffer, not utf8: --binary patches carry arbitrary bytes
    const patch = execFileSync("git", ["-C", wtDir, "diff", "--binary", "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 256 * 1024 * 1024,
    }) as Buffer;
    const tmp = join(tmpdir(), `pai-carry-${process.pid}-${Date.now()}.patch`);
    writeFileSync(tmp, patch);
    try {
      git(cwd, ["apply", "--whitespace=nowarn", tmp]);
    } catch (e) {
      throw new Error(
        `cannot carry the worker's uncommitted changes into ${cwd} — ${(e as Error).message}; ` +
          `the worktree at ${wtDir} was kept: resolve by hand, then re-run merge`
      );
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  for (const rel of untracked) {
    const from = join(wtDir, rel);
    const to = join(cwd, rel);
    if (existsSync(to) && readFileSync(to, "utf8") !== readFileSync(from, "utf8")) {
      throw new Error(
        `cannot carry untracked ${rel}: ${cwd} already has a different file there; ` +
          `the worktree at ${wtDir} was kept: resolve by hand, then re-run merge`
      );
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  return [...tracked, ...untracked];
}

/**
 * `pai worker merge <id>`: merge the worker's branch into the original
 * checkout with --no-ff (the merge commit names the worker), carry any
 * changes the worker left uncommitted, then remove the worktree and delete
 * the branch; the status gains `merged: true`. A branch with nothing to
 * merge is refused loudly — its worktree may hold uncommitted work, and
 * reporting success there would destroy it.
 */
export function mergeWorker(logDir: string, id: string): string {
  const st = mustHaveBranch(logDir, id);
  if (st.merged) return `worker ${id}: branch ${st.branch} already merged`;
  const incoming = parseInt(git(st.cwd, ["rev-list", "--count", `HEAD..${st.branch}`]), 10) || 0;
  if (incoming <= 0) {
    throw new Error(
      `worker ${id}: branch ${st.branch} has no commits to merge. ` +
        `The worktree ${st.worktreeDir} was NOT removed — uncommitted work there would be destroyed. ` +
        `Commit it yourself, or drop everything with: pai worker discard ${id}`
    );
  }
  git(st.cwd, ["merge", "--no-ff", st.branch!, "-m", `merge worker ${id} (${st.label})`]);
  const carried = existsSync(st.worktreeDir!) ? carryUncommitted(st.worktreeDir!, st.cwd) : [];
  removeWorktree(st.cwd, st.worktreeDir!, false);
  let branchGone = true;
  try {
    git(st.cwd, ["branch", "-d", st.branch!]);
  } catch {
    branchGone = false; // -d refuses anything not fully merged; keep the branch, say so
  }
  const s = { ...st, merged: true };
  saveStatus(logDir, s);
  const base = `merged ${st.branch} into ${st.cwd} (worktree removed${branchGone ? ", branch deleted" : "; branch kept: git refused -d"})`;
  return carried.length
    ? `${base}; carried ${carried.length} uncommitted change(s): ${carried.join(", ")}`
    : base;
}

/** `pai worker discard <id>`: drop worktree and branch, keep nothing. */
export function discardWorker(logDir: string, id: string): string {
  const st = mustHaveBranch(logDir, id);
  removeWorktree(st.cwd, st.worktreeDir!, true);
  let branchGone = false;
  try {
    git(st.cwd, ["branch", "-D", st.branch!]);
    branchGone = true;
  } catch {
    branchGone = false;
  }
  const s = { ...st, branch: null, worktreeDir: null, worktreeBase: null, commits: null, merged: false };
  saveStatus(logDir, s);
  return `discarded worker ${id}: worktree removed${branchGone ? `, branch ${st.branch} deleted` : ""}`;
}

function mustHaveBranch(logDir: string, id: string): WorkerStatus & Required<Pick<WorkerStatus, "branch" | "worktreeDir">> {
  const st = loadStatus(logDir, id);
  if (!st) throw new Error(`no worker named "${id}"`);
  if (!st.branch || !st.worktreeDir) {
    throw new Error(
      `worker ${id} has no worktree branch to ${st.branch ? "clean up" : "merge"} — ` +
        `it ran in place or its branch was already handled`
    );
  }
  return st as WorkerStatus & Required<Pick<WorkerStatus, "branch" | "worktreeDir">>;
}

/**
 * The paragraph a worktree run's system prompt gains: it may commit on its
 * own branch (the no-commit rule holds for the main branch only), it must not
 * merge or push itself, and the parent or operator merges.
 */
export function worktreeSystemPrompt(id: string, branch: string, dir: string): string {
  return [
    "You are running in your own git worktree:",
    `  ${dir} on branch ${branch} (worker id ${id}).`,
    "Commit your work on that branch as you go (git add / git commit) — committing here is expected;",
    "the no-commit rule applies to the main branch only, and this is not it.",
    "Do not merge, rebase or push; the operator merges your branch back with `pai worker merge`.",
  ].join("\n");
}
