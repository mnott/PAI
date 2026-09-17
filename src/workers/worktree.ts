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
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadStatus, saveStatus, UNLABELED, type WorkerStatus } from "./status.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath, statusPath } from "./paths.js";

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
  const swept = sweepOrphanWorktrees(logDir);
  if (swept.length) {
    appendLedger(ledgerPath(logDir), "WORKER-NOTE", {
      id,
      note: `swept orphan worktree(s): ${swept.join(", ")}`,
    });
  }
  const dir = worktreePath(logDir, id);
  const branch = worktreeBranch(id);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["worktree", "add", dir, "-b", branch]);
  return { dir, branch, base };
}

/**
 * Remove worktrees (and their `worker/<id>` branches) whose worker no longer
 * exists — no status file left in the log dir. Killed and failed runs clean
 * up after themselves, but a `kill -9` or a crash strands a directory and a
 * branch; every worktree creation sweeps first so they cannot accumulate.
 * Directories younger than `minAgeMin` minutes are left alone: a run that is
 * just starting owns its worktree a moment before its status file exists.
 */
export function sweepOrphanWorktrees(logDir: string, minAgeMin = 10): string[] {
  const root = worktreesDir(logDir);
  if (!existsSync(root)) return [];
  const swept: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    const dir = join(root, id);
    if (existsSync(statusPath(logDir, id))) continue; // a known worker owns it
    try {
      const ageMin = (Date.now() - statSync(dir).mtimeMs) / 60_000;
      if (ageMin < minAgeMin) continue;
    } catch {
      /* vanished mid-sweep; nothing to do */
    }
    let gitDir: string | null = null;
    try {
      const raw = git(dir, ["rev-parse", "--git-common-dir"]);
      gitDir = isAbsolute(raw) ? raw : resolve(dir, raw);
    } catch {
      gitDir = null; // not a worktree anymore; just drop the directory
    }
    removeWorktree(gitDir ?? dir, dir, true);
    if (gitDir) {
      try {
        git(gitDir, ["worktree", "prune"]);
        git(gitDir, ["branch", "-D", worktreeBranch(id)]);
      } catch {
        // branch already gone or kept by git for a reason; the directory is
      }
    }
    swept.push(id);
  }
  return swept;
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
 * Tracked changes (staged or not) plus untracked files — everything a
 * `git add -A` in `wtDir` would commit. The same two calls the old patch
 * carry used; name-only, not porcelain: a worktree-only change renders as
 * " M path" and the shared git() helper trims that leading space away.
 */
export function uncommittedPaths(wtDir: string): string[] {
  const tracked = git(wtDir, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const untracked = git(wtDir, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  return [...tracked, ...untracked];
}

/**
 * Commit a worktree's uncommitted changes to its branch so the merge carries
 * them. `git merge` only moves committed work, so a worker that stopped
 * without committing would lose its edits to `worktree remove` — exactly
 * what happened live on 2026-09-17. Returns the salvaged paths, [] when the
 * worktree is clean. A failed commit throws with the worktree untouched:
 * its edits are still on disk, so nothing is lost.
 */
export function salvageUncommitted(wtDir: string, label: string): string[] {
  const paths = uncommittedPaths(wtDir);
  if (!paths.length) return [];
  try {
    git(wtDir, ["add", "-A"]);
    git(wtDir, ["commit", "-m", `salvaged: ${label}`]);
  } catch (e) {
    throw new Error(
      `cannot salvage the uncommitted changes in ${wtDir} — ${(e as Error).message}; ` +
        `nothing was lost: commit them there by hand, then re-run merge`
    );
  }
  return paths;
}

/**
 * The dirty paths of a checkout, parsed from `git status --porcelain -z`:
 * NUL-separated (a path with a newline in it cannot corrupt the parse),
 * rename entries contribute both sides, and any quoting is stripped.
 */
function dirtyPaths(cwd: string): string[] {
  // raw execFileSync, not the shared git(): it trims stdout, which eats the
  // leading space of a worktree-only " M path" record and breaks the parse
  const raw = execFileSync("git", ["-C", cwd, "status", "--porcelain", "-z"], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fields = raw.split("\0");
  const strip = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f || f.length < 4 || f.charAt(2) !== " ") continue; // not an "XY path" record
    out.push(strip(f.slice(3)));
    const xy = f.slice(0, 2);
    if (xy.includes("R") || xy.includes("C")) {
      const orig = fields[i + 1]; // rename/copy records carry the source path next
      if (orig && orig.charAt(2) !== " ") {
        out.push(strip(orig));
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Refuse the merge when the original checkout is dirty in paths the branch
 * touches: the merge would overwrite those edits or fail on them, either way
 * leaving a half-state. No merge is made, the worktree stays.
 */
function assertNoDirtyOverlap(
  cwd: string,
  incoming: string[],
  id: string,
  branch: string
): void {
  const dirty = new Set(dirtyPaths(cwd));
  const overlap = [...new Set(incoming)].filter((p) => dirty.has(p)).sort();
  if (!overlap.length) return;
  throw new Error(
    `worker ${id}: the checkout ${cwd} has uncommitted changes in paths ${branch} touches: ` +
      `${overlap.join(", ")}. Commit or stash them in the checkout, then re-run: pai worker merge ${id}. ` +
      `No merge was made; the worktree was kept.`
  );
}

/** Never remove a worktree that still holds uncommitted changes. */
export function assertWorktreeClean(wtDir: string, id: string): void {
  const leftover = uncommittedPaths(wtDir);
  if (leftover.length) {
    throw new Error(
      `worker ${id}: the worktree ${wtDir} still holds uncommitted changes ` +
        `(${leftover.join(", ")}) — it was NOT removed; commit or copy them by hand, then re-run merge`
    );
  }
}

/**
 * `pai worker merge <id>`: salvage whatever the worker left uncommitted onto
 * its branch, refuse when the original checkout is dirty in paths the branch
 * touches, merge with --no-ff (the merge commit names the worker), then
 * remove the worktree and delete the branch; the status gains `merged: true`.
 * A branch with nothing to merge is refused loudly — after salvage that
 * genuinely means it holds nothing, and reporting success there would
 * destroy the worktree for no gain.
 */
export function mergeWorker(logDir: string, id: string): string {
  const st = mustHaveBranch(logDir, id);
  if (st.merged) return `worker ${id}: branch ${st.branch} already merged`;
  // salvage first: only a commit can carry uncommitted work through the merge
  const salvaged = existsSync(st.worktreeDir!)
    ? salvageUncommitted(st.worktreeDir!, st.label || UNLABELED)
    : [];
  const incoming = parseInt(git(st.cwd, ["rev-list", "--count", `HEAD..${st.branch}`]), 10) || 0;
  if (incoming <= 0) {
    throw new Error(
      `worker ${id}: branch ${st.branch} has no commits to merge. ` +
        `The worktree ${st.worktreeDir} was NOT removed — uncommitted work there would be destroyed. ` +
        `Commit it yourself, or drop everything with: pai worker discard ${id}`
    );
  }
  const mergeBase = git(st.cwd, ["merge-base", "HEAD", st.branch!]);
  const incomingPaths = git(st.cwd, ["diff", "--name-only", mergeBase, st.branch!])
    .split("\n")
    .filter(Boolean);
  assertNoDirtyOverlap(st.cwd, incomingPaths, id, st.branch!);
  try {
    git(st.cwd, ["merge", "--no-ff", st.branch!, "-m", `merge worker ${id} (${st.label})`]);
  } catch (e) {
    throw new Error(
      `worker ${id}: git refused the merge of ${st.branch} — ${(e as Error).message}. ` +
        `The worktree ${st.worktreeDir} was kept: resolve the conflict, then re-run merge`
    );
  }
  if (existsSync(st.worktreeDir!)) assertWorktreeClean(st.worktreeDir!, id);
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
  return salvaged.length
    ? `${base}; salvaged ${salvaged.length} uncommitted change(s): ${salvaged.join(", ")}`
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
    "Use ONLY relative paths inside the worktree, never absolute worktree paths — absolute paths break after merge and leak machine layout.",
  ].join("\n");
}
