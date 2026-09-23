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
 * Pure: no fs, no config read, no process.env read of its own. The hook
 * (pre-tool-use/security-validator.ts) resolves whether the session is a
 * worker and where its worktrees root is, and passes both in.
 */

const TREE_REWRITE: { name: string; pattern: RegExp }[] = [
  { name: "git reset", pattern: /\bgit(?:\s+-C\s+\S+)?\s+reset\b/ },
  { name: "git clean", pattern: /\bgit(?:\s+-C\s+\S+)?\s+clean\b/ },
  { name: "git restore", pattern: /\bgit(?:\s+-C\s+\S+)?\s+restore\b/ },
  { name: "git switch", pattern: /\bgit(?:\s+-C\s+\S+)?\s+switch\b/ },
  { name: "git rebase", pattern: /\bgit(?:\s+-C\s+\S+)?\s+rebase\b/ },
  { name: "git merge", pattern: /\bgit(?:\s+-C\s+\S+)?\s+merge\b/ },
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
