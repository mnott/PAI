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
import { capContent } from "./rules/cap.js";

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

const GIT_WRITE = /\bgit\b[^&;|\n]*?\s(?:commit|add|am|cherry-pick|apply|push|tag|rm|mv)(?![\w-])/;
const UNKNOWN_DIR = "/\0unresolved";

const READONLY_GIT = new Set([
  "log", "show", "diff", "rev-parse", "rev-list", "merge-base", "status", "ls-files", "ls-tree",
  "cat-file", "blame", "describe", "shortlog", "grep", "for-each-ref", "name-rev",
]);

/** Global options that take a separate value argument. */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * True when the segment runs git with a subcommand that can modify a repo.
 * Read-only subcommands (and read-only forms of tag/branch/config/remote/
 * worktree) are not writes wherever they point. A segment with no parseable
 * git invocation falls back to the keyword pattern.
 */
function segmentWritesGit(segment: string, rest: string[]): boolean {
  const g = rest.indexOf("git");
  if (g < 0) return GIT_WRITE.test(segment);
  let k = g + 1;
  while (k < rest.length && rest[k].startsWith("-")) k += GIT_VALUE_OPTS.has(rest[k]) ? 2 : 1;
  const sub = rest[k];
  if (sub === undefined) return false;
  const args = rest.slice(k + 1).filter((a) => !/^[<>]|^\d*>/.test(a));
  if (READONLY_GIT.has(sub)) return false;
  const opts = (set: string[]) => args.every((a) => set.some((s) => a === s || a.startsWith(`${s}=`)));
  const noPositional = args.every((a) => a.startsWith("-"));
  switch (sub) {
    case "tag":
      return !(args.length === 0 || (noPositional && opts(["-l", "--list", "--sort", "--contains", "--points-at", "--merged", "--no-merged", "-n", "--format"])));
    case "branch":
      return !(args.length === 0 || (noPositional && opts(["--list", "-l", "-a", "-r", "--all", "--remotes", "--show-current", "--contains", "--merged", "--no-merged", "-v", "-vv", "--sort", "--format", "--points-at"])));
    case "config":
      return !(args[0] === "--get" || args[0] === "--get-all" || args[0] === "--list" || args[0] === "-l");
    case "remote":
      return !(args.length === 0 || args[0] === "-v" || args[0] === "show" || args[0] === "get-url");
    case "worktree":
      return args[0] !== "list";
    default:
      return true;
  }
}

/** Splits on &&, ||, ;, | and newlines outside quotes. */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "&" || c === "|" || c === ";" || c === "\n") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Whitespace tokens with surrounding quotes removed. */
function tokenize(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
}

/** A path against `base`; `~` and `$` expansions cannot be resolved here and count as unresolved. */
function resolveDir(base: string, p: string): string {
  return /^~|\$|`/.test(p) ? UNKNOWN_DIR : resolve(base, p);
}

/**
 * The directory a command is in after the `cd` segments of `prefix` ran, from
 * `cwd`. `$TMPDIR` / `${TMPDIR}` expand to the hook's TMPDIR (kept literal
 * when unset); other expansions leave the dir unresolved (UNKNOWN_DIR).
 */
export function cwdAfterCds(prefix: string, cwd: string): string {
  let here = cwd;
  for (const segment of splitSegments(prefix)) {
    const rest = tokenize(segment);
    if (rest[0] !== "cd") continue;
    const arg = rest.slice(1).find((t) => !t.startsWith("-"));
    if (arg === undefined) continue;
    const m = /^\$\{?TMPDIR\}?(\/.*)?$/.exec(arg);
    here = m ? (process.env.TMPDIR?.replace(/\/$/, "") ?? "$TMPDIR") + (m[1] ?? "") : resolveDir(here, arg);
  }
  return here;
}

/** The work tree a git dir belongs to: `<tree>/.git` is `<tree>`. */
function treeOfGitDir(dir: string): string {
  return dir.endsWith("/.git") ? dir.slice(0, -5) : dir;
}

/**
 * A worker inside its own worktree that points a git write at a directory
 * elsewhere (typically the operator's main checkout named in its spec)
 * commits there instead of on its branch — seen 2026-10-22. Each command
 * segment is judged on its own: `cd`, `git -C`, `--git-dir`, `--work-tree`
 * and GIT_DIR / GIT_WORK_TREE retarget it, relative paths resolve against the
 * hook's cwd and the cwd left by earlier `cd` segments. Scratch dirs and other
 * worktrees stay allowed.
 */
function worktreeEscape(command: string, cwd: string, worktreesRoot: string): boolean {
  const allowed = (dir: string) =>
    isInsideWorktree(dir, cwd) ||
    isInsideWorktree(dir, worktreesRoot) ||
    /^\/(tmp|private\/tmp|var\/folders|private\/var\/folders)(\/|$)/.test(dir);
  let here = cwd;
  const env: Record<string, string> = {};
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    const segEnv: Record<string, string> = {};
    let i = 0;
    let exported = false;
    if (tokens[0] === "export") {
      exported = true;
      i = 1;
    }
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      const eq = tokens[i].indexOf("=");
      (exported ? env : segEnv)[tokens[i].slice(0, eq)] = tokens[i].slice(eq + 1);
      i++;
    }
    if (exported) continue;
    const rest = tokens.slice(i);
    if (rest[0] === "cd") {
      const arg = rest.slice(1).find((t) => !t.startsWith("-"));
      here = arg === undefined ? here : resolveDir(here, arg);
      continue;
    }
    if (!segmentWritesGit(segment, rest)) continue;
    const targets = [here];
    const eff = { ...env, ...segEnv };
    if (eff.GIT_DIR) targets.push(treeOfGitDir(resolveDir(here, eff.GIT_DIR)));
    if (eff.GIT_WORK_TREE) targets.push(resolveDir(here, eff.GIT_WORK_TREE));
    let dir = here;
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (t === "-C" && k + 1 < rest.length) {
        dir = resolveDir(dir, rest[++k]);
        targets.push(dir);
      } else if (t === "--git-dir" || t === "--work-tree") {
        const v = rest[++k] ?? "";
        targets.push(t === "--git-dir" ? treeOfGitDir(resolveDir(here, v)) : resolveDir(here, v));
      } else if (t.startsWith("--git-dir=")) targets.push(treeOfGitDir(resolveDir(here, t.slice(10))));
      else if (t.startsWith("--work-tree=")) targets.push(resolveDir(here, t.slice(12)));
    }
    if (targets.some((d) => !allowed(d))) return true;
  }
  return false;
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
  command = capContent(command); // the git patterns below are not linear on megabytes of padding
  if (worktreesRoot && isInsideWorktree(cwd, worktreesRoot)) {
    return worktreeEscape(command, cwd, worktreesRoot) ? { blocked: true, cmd: "git write outside the worktree" } : { blocked: false };
  }
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
    cmd === "git write outside the worktree"
      ? "worker: git write aimed at a directory outside your worktree is blocked; use relative paths and commit on your own branch"
      : `in-place worker: ${cmd} rewrites the shared checkout and is blocked; ` +
        "take baselines from the numbers before your edit, or run with --worktree"
  );
}
