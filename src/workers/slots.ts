import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { git, uncommittedPaths, worktreeBranch, worktreesDir, ensureScratchExcluded, provisionDeps, type WorktreeInfo } from "./worktree.js";

export function slotsDir(logDir: string): string {
  return join(logDir, "slots");
}

export function slotPath(logDir: string, provider: string, n: number): string {
  return join(slotsDir(logDir), `${provider}-${n}`);
}

export function slotRepo(dir: string): string | null {
  try {
    const raw = git(dir, ["rev-parse", "--git-common-dir"]);
    const resolved = isAbsolute(raw) ? raw : resolve(dir, raw);
    return realpathSync(resolved);
  } catch {
    return null;
  }
}

export function slotServesRepo(logDir: string, provider: string, n: number, repo: string): boolean {
  const dir = slotPath(logDir, provider, n);
  if (!existsSync(dir)) return true;
  const slotRepoPath = slotRepo(dir);
  if (!slotRepoPath) return false;
  try {
    const repoCommon = git(repo, ["rev-parse", "--git-common-dir"]);
    const resolvedRepo = isAbsolute(repoCommon) ? repoCommon : resolve(repo, repoCommon);
    return slotRepoPath === realpathSync(resolvedRepo);
  } catch {
    return false;
  }
}

export function ensureSlotWorktree(logDir: string, provider: string, n: number, repo: string): string {
  const dir = slotPath(logDir, provider, n);
  if (!existsSync(dir)) {
    mkdirSync(slotsDir(logDir), { recursive: true });
    git(repo, ["worktree", "add", "--detach", dir, "HEAD"]);
    provisionDeps(logDir, `slot-${provider}-${n}`, repo, dir);
  } else if (!slotServesRepo(logDir, provider, n, repo)) {
    throw new Error(`slot ${dir} belongs to another repository`);
  }
  return dir;
}

export interface SlotPrep extends WorktreeInfo {
  salvagePatch: string | null;
}

export function prepareSlot(logDir: string, provider: string, n: number, repo: string, taskId: string, baseRef?: string): SlotPrep {
  const dir = ensureSlotWorktree(logDir, provider, n, repo);
  let salvagePatch: string | null = null;

  if (uncommittedPaths(dir).length > 0) {
    const patchPath = join(tmpdir(), `pai-slot-salvage-${taskId}.patch`);
    const diff = git(dir, ["diff", "HEAD"]);
    const uncommitted = uncommittedPaths(dir);
    const untracked = uncommitted.filter(p => !p.startsWith(".git/"));
    writeFileSync(patchPath, `${diff}\nuntracked/other: ${untracked.join(" ")}\n`);
    salvagePatch = patchPath;
    git(dir, ["reset", "--hard", "-q"]);
    git(dir, ["clean", "-fdq"]);
  }

  const base = baseRef ?? git(repo, ["rev-parse", "HEAD"]);
  const branch = worktreeBranch(taskId);
  // Ensure the branch doesn't already exist before creating it
  try {
    git(dir, ["checkout", "-q", "-f", "-b", branch, base]);
  } catch (e) {
    // If branch already exists, clean it up and try again
    git(dir, ["branch", "-D", branch]);
    git(dir, ["checkout", "-q", "-f", "-b", branch, base]);
  }

  return { dir, branch, base, snapshot: false, salvagePatch };
}

export function releaseSlot(dir: string, branch: string, base: string): { commits: number } {
  git(dir, ["checkout", "-q", "--detach"]);
  let commits = 0;
  try {
    commits = parseInt(git(dir, ["rev-list", "--count", `${base}..${branch}`]), 10) || 0;
  } catch {
    commits = 0;
  }

  if (commits === 0) {
    try {
      git(dir, ["branch", "-D", branch]);
    } catch {
      // branch already gone
    }
  }

  return { commits };
}

/** Branch a spare's worktree starts on; a claim renames it to worker/<id>. */
export function spareBranch(sid: string): string {
  return `spare/${sid}`;
}

/**
 * A spare's worktree: cut from the repo's current HEAD on its own branch under
 * <logDir>/worktrees/<sid>, node_modules cloned the way a fresh worker's is.
 * Throws when git refuses (the caller starts no spare).
 */
export function addSpareWorktree(logDir: string, repo: string, sid: string): { dir: string; branch: string; base: string } {
  const dir = join(worktreesDir(logDir), sid);
  const branch = spareBranch(sid);
  const base = git(repo, ["rev-parse", "HEAD"]);
  ensureScratchExcluded(repo);
  git(repo, ["worktree", "add", dir, "-b", branch, base]);
  provisionDeps(logDir, sid, repo, dir);
  return { dir, branch, base };
}

/** Drop an unclaimed spare's worktree and branch; best effort. */
export function removeSpareWorktree(repo: string, dir: string, branch: string): void {
  try {
    git(repo, ["worktree", "remove", "--force", dir]);
  } catch {
    /* already gone */
  }
  try {
    git(repo, ["branch", "-D", branch]);
  } catch {
    /* renamed or gone */
  }
}
