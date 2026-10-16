/**
 * worker-git-guard.ts — blocks tree-rewriting git commands from an in-place
 * worker: one whose cwd is the operator's checkout itself, not a worktree
 * under `<workers logDir>/worktrees/`.
 *
 * `git stash` (or reset/clean/checkout --/restore/switch/rebase/merge) in a
 * shared checkout can drop or conflict with another worker's in-flight
 * edits — observed twice on 2026-09-22, each time with a spec that already
 * said "do not run git stash" in prose. Prose did not stop it; this gate
 * does.
 *
 * The one fs read is `isPrivateClone`: a repo whose git dir holds the
 * `pai-private-clone` marker was cloned by its creator for one worker only,
 * so nothing shared can be harmed there. The hook
 * (pre-tool-use/security-validator.ts) resolves whether the session is a
 * worker and where its worktrees root is, and passes both in.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const PRIVATE_CLONE_MARKER = "pai-private-clone";

/** True iff the git dir of the repo containing `cwd` holds the marker; any failure is false. */
export function isPrivateClone(cwd: string): boolean {
  try {
    const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return existsSync(join(resolve(gitDir), PRIVATE_CLONE_MARKER));
  } catch {
    return false;
  }
}

/** A command that names another directory must not borrow cwd's marker. */
const NAMES_OTHER_DIR = /\bgit\s+-C\b|\bcd\s/;

const TREE_REWRITE: { name: string; pattern: RegExp }[] = [
  { name: "git reset", pattern: /\bgit(?:\s+-C\s+\S+)?\s+reset(?![\w-])/ },
  { name: "git clean", pattern: /\bgit(?:\s+-C\s+\S+)?\s+clean(?![\w-])/ },
  { name: "git restore", pattern: /\bgit(?:\s+-C\s+\S+)?\s+restore(?![\w-])/ },
  { name: "git switch", pattern: /\bgit(?:\s+-C\s+\S+)?\s+switch(?![\w-])/ },
  { name: "git rebase", pattern: /\bgit(?:\s+-C\s+\S+)?\s+rebase(?![\w-])/ },
  { name: "git merge", pattern: /\bgit(?:\s+-C\s+\S+)?\s+merge(?![\w-])/ },
];

/**
 * `git checkout` only rewrites the tree when it names paths (`-- <paths>`,
 * with or without a leading ref) or restores everything (`git checkout .`).
 * A bare `git checkout <branch>` is a branch switch, not covered here —
 * `git switch` above is the tree-rewriting form of that.
 */
const CHECKOUT_INVOCATION = /\bgit(?:\s+-C\s+\S+)?\s+checkout\s+([^&;|`\n)]*)/g;

function checkoutRewritesTree(command: string): boolean {
  CHECKOUT_INVOCATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHECKOUT_INVOCATION.exec(command))) {
    const args = m[1].trim();
    if (args === ".") return true;
    if (/(^|\s)--(\s|$)/.test(args)) return true;
  }
  return false;
}

/**
 * `git stash list` and `git stash show` only read the stash; every other
 * subcommand (push/pop/apply/drop/clear/save/create/store/branch) and the
 * bare `git stash` (a push) can drop or conflict with in-flight edits.
 */
const STASH_INVOCATION = /\bgit(?:\s+-C\s+\S+)?\s+stash\b(?:\s+(\S+))?/g;
const STASH_READONLY_SUBCOMMANDS = new Set(["list", "show"]);

function stashRewritesTree(command: string): boolean {
  STASH_INVOCATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STASH_INVOCATION.exec(command))) {
    const sub = m[1];
    if (!sub || !STASH_READONLY_SUBCOMMANDS.has(sub)) return true;
  }
  return false;
}

/** Absolute-path prefix check; `root` with or without a trailing separator. */
function isInsideWorktree(cwd: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`);
}

export interface WorkerGitGuardResult {
  blocked: boolean;
  /** The tree-rewriting git invocation matched, e.g. "git stash". */
  cmd?: string;
}

/**
 * `worktreesRoot` is the absolute worktrees directory (see
 * `worktreesDir` in src/workers/worktree.ts), or null when the hook could
 * not resolve it. Null cannot prove `cwd` is a worktree, so a worker blocks
 * in that case too — the guard fails closed on tree-rewriting git, not open.
 */
export function decideWorkerGitGuard(
  command: string,
  isWorker: boolean,
  cwd: string,
  worktreesRoot: string | null
): WorkerGitGuardResult {
  if (!isWorker) return { blocked: false };
  if (worktreesRoot && isInsideWorktree(cwd, worktreesRoot)) return { blocked: false };
  if (!NAMES_OTHER_DIR.test(command) && isPrivateClone(cwd)) return { blocked: false };

  for (const { name, pattern } of TREE_REWRITE) {
    if (pattern.test(command)) return { blocked: true, cmd: name };
  }
  if (checkoutRewritesTree(command)) return { blocked: true, cmd: "git checkout" };
  if (stashRewritesTree(command)) return { blocked: true, cmd: "git stash" };
  return { blocked: false };
}

export function workerGitGuardMessage(cmd: string): string {
  return (
    `in-place worker: ${cmd} rewrites the shared checkout and is blocked; ` +
    "take baselines from the numbers before your edit, or run with --worktree"
  );
}
