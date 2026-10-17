import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { git, uncommittedPaths, worktreeBranch, provisionDeps, type WorktreeInfo } from "./worktree.js";

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