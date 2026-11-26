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
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
 * Every `git checkout` with arguments is blocked: path restores rewrite the
 * tree, and `<branch>` / `-b` / `-B` move the shared checkout's HEAD (which
 * made `pai worker merge` refuse). Only the bare form and --help pass.
 */
const CHECKOUT_INVOCATION = /\bgit(?:\s+-C\s+\S+)?\s+checkout\s+([^&;|`\n)]*)/g;

function checkoutRewritesTree(command: string): boolean {
  CHECKOUT_INVOCATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHECKOUT_INVOCATION.exec(command))) {
    const args = m[1].trim();
    if (args === "" || /^(--help|-h)$/.test(args)) continue; // read-only
    return true; // path restore, branch switch, -b/-B create: all move or rewrite the shared checkout
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
/** realpath of the deepest existing ancestor plus the rest, so symlinked prefixes compare equal. */
function realLoose(p: string): string {
  if (p === "/\0unresolved") return p;
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head) && resolve(head, "..") !== head) {
    tail.unshift(head.slice(resolve(head, "..").length).replace(/^\//, ""));
    head = resolve(head, "..");
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return p;
  }
}

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
  // With a list flag the positionals are patterns, so it only reads unless a write flag is present.
  const listOnly = (listFlags: string[], writeFlags: string[]) =>
    args.some((a) => listFlags.includes(a)) && !args.some((a) => writeFlags.some((w) => a === w || a.startsWith(`${w}=`)));
  switch (sub) {
    case "tag":
      if (listOnly(["-l", "--list"], ["-d", "--delete", "-a", "-s", "-u", "-f", "--force", "-m", "-F"])) return false;
      return !(args.length === 0 || (noPositional && opts(["-l", "--list", "--sort", "--contains", "--points-at", "--merged", "--no-merged", "-n", "--format"])));
    case "branch":
      if (listOnly(["-l", "--list"], ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-u", "--set-upstream-to", "--unset-upstream", "-f", "--force", "--edit-description"])) return false;
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
function resolveDir(base: string, p: string, vars: Record<string, string> = {}): string {
  const sub = (s: string) => s.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a: string | undefined, b: string | undefined) => {
    const name = a ?? b ?? "";
    return vars[name] ?? (name === "TMPDIR" ? process.env.TMPDIR : undefined) ?? (name === "HOME" ? homedir() : undefined) ?? m;
  });
  const home = /^~(?=\/|$)/.test(p) ? homedir() + p.slice(1) : p;
  const expanded = sub(sub(home));
  return /^~|\$|`/.test(expanded) ? UNKNOWN_DIR : resolve(base, expanded);
}

/** A worker's private scratch: `<tmp>/pai-scratch/<id>`, with or without the /private prefix. */
function isOwnScratch(dir: string, id: string): boolean {
  const roots = [`/private/tmp/pai-scratch/${id}`, `/tmp/pai-scratch/${id}`];
  const tmp = process.env.TMPDIR;
  if (tmp) roots.push(join(tmp, "pai-scratch", id));
  if (tmp && tmp.replace(/\/$/, "").endsWith(`/pai-scratch/${id}`)) roots.push(tmp);
  if (roots.some((r) => isInsideWorktree(dir, r) || isInsideWorktree(dir, `/private${r}`))) return true;
  return new RegExp(`^/(private/)?var/folders/[^/]+/[^/]+/T/pai-scratch/${id.replace(/[^\w-]/g, "")}(/|$)`).test(dir);
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

const CLONE_VALUE_OPTS = new Set([
  "-b", "--branch", "--depth", "-o", "--origin", "-c", "--config", "--reference", "--reference-if-able",
  "--template", "-j", "--jobs", "--filter", "--shallow-since", "--shallow-exclude", "-u", "--upload-pack",
  "--server-option", "--bundle-uri", "--ref-format",
]);

/** Roots a fresh clone may land in besides the worker's own worktree. */
function scratchRoots(): string[] {
  const roots = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  const tmp = process.env.TMPDIR?.replace(/\/$/, "");
  if (tmp) roots.push(tmp);
  return roots;
}

/**
 * `git clone <url> [dest]` writes no existing repository when dest (or the
 * repo basename) is new or an empty dir, lies in the worker's worktree or a
 * scratch root, and is not inside another existing git work tree.
 */
function cloneDestOf(rest: string[], here: string, vars: Record<string, string>): string | null {
  const g = rest.indexOf("git");
  if (g < 0 || rest[g + 1] !== "clone") return null;
  const pos: string[] = [];
  for (let k = g + 2; k < rest.length; k++) {
    const t = rest[k];
    if (/^[<>]|^\d*>/.test(t)) continue;
    if (t === "--separate-git-dir" || t.startsWith("--separate-git-dir=")) return UNKNOWN_DIR;
    if (CLONE_VALUE_OPTS.has(t)) k++;
    else if (!t.startsWith("-")) pos.push(t);
  }
  if (pos.length < 1 || pos.length > 2) return null;
  const name = pos[1] ?? pos[0].replace(/[/\\]+$/, "").replace(/\.git$/, "").split(/[/:\\]/).pop() ?? "";
  if (!name || name === "." || name === "..") return null;
  return resolveDir(here, pos[1] ?? name, vars);
}

function freshCloneAllowed(rest: string[], here: string, vars: Record<string, string>, own: string): boolean {
  const dest = cloneDestOf(rest, here, vars);
  if (!dest || dest === UNKNOWN_DIR) return false;
  const inRoot = (d: string, r: string) => isInsideWorktree(d, r);
  const okRoot = (d: string) => inRoot(d, own) || scratchRoots().some((r) => inRoot(d, r));
  if (!okRoot(dest)) return false;
  if (existsSync(dest)) {
    try {
      if (!statSync(dest).isDirectory() || readdirSync(dest).length > 0) return false;
    } catch {
      return false;
    }
  }
  for (let d = dest; ; d = resolve(d, "..")) {
    if (d !== dest || existsSync(dest)) {
      if (existsSync(join(d, ".git"))) return okRoot(d);
    }
    if (resolve(d, "..") === d) break;
  }
  return true;
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
  const id = cwd.slice(worktreesRoot.replace(/\/$/, "").length + 1).split("/")[0];
  const own = join(worktreesRoot, id);
  const realOwn = realLoose(own);
  const allowed = (dir: string) => {
    const real = realLoose(dir);
    return isInsideWorktree(dir, own) || isInsideWorktree(real, realOwn) || isOwnScratch(dir, id) || isOwnScratch(real, id);
  };
  let here = cwd;
  const env: Record<string, string> = {};
  const vars: Record<string, string> = {};
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
      if (exported || tokens.length === i + 1) vars[tokens[i].slice(0, eq)] = tokens[i].slice(eq + 1);
      i++;
    }
    if (exported) continue;
    const rest = tokens.slice(i);
    if (rest[0] === "cd") {
      const arg = rest.slice(1).find((t) => !t.startsWith("-"));
      here = arg === undefined ? here : resolveDir(here, arg, vars);
      continue;
    }
    if (!segmentWritesGit(segment, rest)) continue;
    const eff = { ...env, ...segEnv };
    if (!eff.GIT_DIR && !eff.GIT_WORK_TREE && freshCloneAllowed(rest, here, vars, own)) continue;
    const targets = [here];
    const cloneDest = cloneDestOf(rest, here, vars);
    if (cloneDest) targets.push(cloneDest);
    if (eff.GIT_DIR) targets.push(treeOfGitDir(resolveDir(here, eff.GIT_DIR, vars)));
    if (eff.GIT_WORK_TREE) targets.push(resolveDir(here, eff.GIT_WORK_TREE, vars));
    let dir = here;
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (t === "-C" && k + 1 < rest.length) {
        dir = resolveDir(dir, rest[++k], vars);
        targets.push(dir);
      } else if (t === "--git-dir" || t === "--work-tree") {
        const v = rest[++k] ?? "";
        targets.push(t === "--git-dir" ? treeOfGitDir(resolveDir(here, v, vars)) : resolveDir(here, v, vars));
      } else if (t.startsWith("--git-dir=")) targets.push(treeOfGitDir(resolveDir(here, t.slice(10), vars)));
      else if (t.startsWith("--work-tree=")) targets.push(resolveDir(here, t.slice(12), vars));
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
