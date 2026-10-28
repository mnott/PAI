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

import { removeScratch } from "./scratch.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir, platform } from "node:os";
import { isLive, loadStatus, loadStatuses, saveStatus, UNLABELED, type WorkerStatus } from "./status.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath, statusPath } from "./paths.js";
import { escalationState, invalidatePendingCache } from "./pending.js";
import { poolStatePath, readPoolState } from "./pool.js";
import { loadConfig } from "../daemon/config.js";
import { acquireTestSlotSync, holdsTestSlot, SLOT_HELD_ENV } from "./test-slot.js";
import { DEFAULT_VERIFY, DEFAULT_VERIFY_TIMEOUT_SEC, failureHints, runRelatedTests, type RelatedResult } from "./merge-tests.js";

/** A slot worktree (<logDir>/slots/<name>): persistent, shared by many tasks, never removed per task. */
export function isSlotWorktree(dir: string): boolean { return basename(dirname(resolve(dir))) === "slots"; }

export function worktreesDir(logDir: string): string {
  return join(logDir, "worktrees");
}

export function worktreeBranch(id: string): string {
  return `worker/${id}`;
}

export function worktreePath(logDir: string, id: string): string {
  return join(worktreesDir(logDir), id);
}

/**
 * The one answer to "which tree does this worker own?": its recorded
 * worktreeDir + branch, or null when it has none or was superseded by a
 * resume (the tree moved to the resuming id, see `adoptTree`). discard, merge,
 * gc and ps all ask here.
 */
export function ownedTree(st: WorkerStatus): { dir: string; branch: string } | null {
  if (st.resumedBy || !st.worktreeDir || !st.branch) return null;
  return { dir: st.worktreeDir, branch: st.branch };
}

/**
 * `pai worker resume`: the resuming id takes over the old id's tree. Returns
 * the tree as a WorktreeInfo for the new run, or null when the old id owns
 * none (or its directory is gone). Nothing is written until `markResumed`.
 */
export function adoptTree(logDir: string, oldId: string): (WorktreeInfo & { cwd: string }) | null {
  const old = loadStatus(logDir, oldId);
  const t = old && ownedTree(old);
  if (!old || !t || !existsSync(t.dir)) return null;
  return { dir: t.dir, branch: t.branch, base: old.worktreeBase ?? "", snapshot: !!old.worktreeSnapshot, cwd: old.cwd };
}

/** Hand the old id's tree over: it records `resumedBy` and no longer owns anything. */
export function markResumed(logDir: string, oldId: string, newId: string): void {
  const old = loadStatus(logDir, oldId);
  if (!old) return;
  saveStatus(logDir, {
    ...old,
    resumedBy: newId,
    worktreeDir: null,
    branch: null,
    worktreeBase: null,
    worktreeSnapshot: null,
    commits: null,
  });
  invalidatePendingCache(logDir, old.cwd);
}

/** One git call's stdout ceiling: a merge's -U0 diff spans every changed file, so the 1 MB default died with ENOBUFS. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Run git in `cwd` with an optional env override, trimmed stdout, stderr on failure. */
function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 30_000): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
    }).trim();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string; status?: number };
    const why =
      (typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8")) ||
      err.message ||
      String(e);
    throw Object.assign(new Error(`git ${args.join(" ")} in ${cwd}: ${why.trim()}`), { status: err.status });
  }
}

/** `git merge-base --is-ancestor`: exit 1 means "no", any other failure throws. */
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 1) return false;
    throw e;
  }
}

/** Run git in `cwd`, returning trimmed stdout; throws with stderr on failure. */
export function git(cwd: string, args: string[], timeoutMs?: number): string {
  return runGit(cwd, args, undefined, timeoutMs);
}

/** Is `cwd` inside a git repository (a .git dir — worktrees: a .git file)? */
export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--git-dir"]) !== "";
  } catch {
    return false;
  }
}

/** Tools that can write to the checkout (Bash can, via the shell). */
const WRITING_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];

/** Can a run with these --allowedTools write? No restriction at all means yes. */
export function toolsCanWrite(allowedTools: string[]): boolean {
  const names = allowedTools.flatMap((e) => e.split(",")).map((s) => s.trim().replace(/\(.*$/, "")).filter(Boolean);
  return !names.length || names.some((n) => WRITING_TOOLS.includes(n));
}

/** How the run flags decide the worktree question; undefined = decide by default. */
export type WorktreeFlag = boolean | undefined;

/** Should this run get a worktree? Explicit flag first, then: can it write? */
export function worktreeWanted(flag: WorktreeFlag, opts: { cwd: string; allowedTools: string[] }): boolean {
  if (flag !== undefined) return flag;
  return toolsCanWrite(opts.allowedTools) && isGitRepo(opts.cwd);
}

export interface WorktreeInfo {
  dir: string;
  branch: string;
  base: string;
  /** `base` is a snapshot commit of uncommitted checkout state, not HEAD itself. */
  snapshot: boolean;
  /** Set when a dirty checkout was NOT snapshotted, and why (a running in-place worker is editing it). */
  snapshotSkipped?: string;
}

/** Live workers running in place (no worktree of their own) in the same checkout as `cwd`. */
function runningInPlaceWorkers(logDir: string, id: string, cwd: string): string[] {
  let root: string;
  try {
    root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return [];
  }
  const same = (c: string): boolean => {
    try {
      return realpathSync(git(c, ["rev-parse", "--show-toplevel"])) === root;
    } catch {
      return false;
    }
  };
  return loadStatuses(logDir)
    .filter((s) => s.id !== id && isLive(s) && !s.worktreeDir && !s.resumedBy && existsSync(s.cwd) && same(s.cwd))
    .map((s) => s.id);
}

/** Does branch `name` exist in `cwd`'s repository? */
function branchExists(cwd: string, name: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Is branch `name` checked out in any worktree of the repository? */
function branchCheckedOut(cwd: string, name: string): boolean {
  return git(cwd, ["worktree", "list", "--porcelain"]).split("\n").includes(`branch refs/heads/${name}`);
}

/**
 * The branch to create the worktree on. A leftover branch of the same worker id
 * is reused (reset to `base` by `worktree add -B`) when it holds no commit
 * beyond HEAD and is checked out nowhere; otherwise the first free `<name>-N`.
 */
function pickBranch(cwd: string, id: string, head: string): string {
  const first = worktreeBranch(id);
  if (!branchExists(cwd, first)) return first;
  if (!branchCheckedOut(cwd, first) && commitsSince(cwd, head, first) === 0) return first;
  for (let n = 2; ; n++) {
    const name = `${first}-${n}`;
    if (!branchExists(cwd, name)) return name;
  }
}

/**
 * Worker safety is a hard gate: when no worktree could be made, a run whose
 * tools can write must not start in place. Logs WORKER-NO-WORKTREE and returns
 * true (start must fail); read-only runs may go on in place (false).
 */
export function worktreeRefusesStart(logDir: string, id: string, why: string, allowedTools: string[]): boolean {
  if (!toolsCanWrite(allowedTools)) return false;
  appendLedger(ledgerPath(logDir), "WORKER-NO-WORKTREE", { id, reason: why });
  return true;
}

/** Paths PAI itself rewrites (Notes/, TODO*.md at the root or in Notes/): never part of a snapshot. */
export function isPaiBookkeepingPath(path: string): boolean {
  return /^notes\//i.test(path) || /^TODO[^/]*\.md$/.test(path);
}

/**
 * Keep the PAI scratch dir out of git for good: add `.pai-scratch/` to the
 * repository's info/exclude (shared by all its worktrees; idempotent), so the
 * snapshot, status and salvage never see an orchestrator's scratch files.
 */
export function ensureScratchExcluded(cwd: string): void {
  try {
    const rel = git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
    const file = isAbsolute(rel) ? rel : resolve(cwd, rel);
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (cur.split("\n").some((l) => l.trim() === ".pai-scratch/")) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${cur}${cur === "" || cur.endsWith("\n") ? "" : "\n"}.pai-scratch/\n`, "utf8");
  } catch {
    /* best effort: the snapshot still works, just may carry scratch */
  }
}

/**
 * Create `<dir>/.pai-scratch/` in a freshly added worktree: the guard tells
 * workers one-time checks go there, and a fresh tree has none, so their first
 * `> .pai-scratch/x` failed with "No such file or directory". Already
 * info/excluded (see `ensureScratchExcluded`), so status and salvage never
 * see it. Best effort.
 */
export function ensureScratchDir(dir: string): void {
  try {
    mkdirSync(join(dir, ".pai-scratch"), { recursive: true });
  } catch {
    /* best effort */
  }
}

/**
 * Commit `cwd`'s current index + working tree (including untracked files) as
 * a floating commit on top of HEAD, without touching the real index, working
 * tree or HEAD: a temporary `GIT_INDEX_FILE` collects the snapshot, `git
 * commit-tree` writes the commit object directly (it updates no ref). The
 * caller then branches a worktree from that commit, so the worktree sees
 * exactly what was on disk, uncommitted or not.
 */
function snapshotUncommitted(cwd: string, id: string, head: string, bookkeeping: string[]): string {
  const idxDir = mkdtempSync(join(tmpdir(), "pai-worktree-idx-"));
  const idx = join(idxDir, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    runGit(cwd, ["read-tree", head], env);
    runGit(cwd, ["add", "-A"], env);
    // PAI's own bookkeeping stays at its HEAD state in the snapshot
    if (bookkeeping.length) runGit(cwd, ["--literal-pathspecs", "reset", "-q", head, "--", ...bookkeeping], env);
    const tree = runGit(cwd, ["write-tree"], env);
    return runGit(cwd, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      `worker ${id}: snapshot of uncommitted checkout`,
    ]);
  } finally {
    rmSync(idxDir, { recursive: true, force: true });
  }
}

/**
 * Create the worktree and branch for `id` from `cwd`'s HEAD — or, when the
 * checkout has uncommitted changes, from a snapshot commit of that dirty
 * state (see `snapshotUncommitted`), so a worktree worker sees the same
 * files the operator sees, not just what was last committed. Throws when git
 * refuses (no commits yet, …) — see `worktreeRefusesStart`.
 */
export function addWorktree(logDir: string, id: string, cwd: string): WorktreeInfo {
  const dir = worktreePath(logDir, id);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const branch = pickBranch(cwd, id, head);
  ensureScratchExcluded(cwd);
  const all = dirtyPaths(cwd);
  const bookkeeping = all.filter(isPaiBookkeepingPath);
  let dirty = all.length > bookkeeping.length;
  // a running in-place worker owns those edits: snapshotting would carry its half-done files elsewhere
  const editing = dirty ? runningInPlaceWorkers(logDir, id, cwd) : [];
  const snapshotSkipped = editing.length
    ? `checkout is dirty because in-place worker(s) ${editing.join(", ")} are running in it; no snapshot, branching from HEAD`
    : undefined;
  if (snapshotSkipped) dirty = false;
  const base = dirty ? snapshotUncommitted(cwd, id, head, bookkeeping) : head;
  // -B: a reusable leftover branch is reset to base; a fresh name is simply created
  git(cwd, ["worktree", "add", "-B", branch, dir, base]);
  ensureScratchDir(dir);
  provisionDeps(logDir, id, cwd, dir);
  return { dir, branch, base, snapshot: dirty, ...(snapshotSkipped ? { snapshotSkipped } : {}) };
}

/**
 * Give the worktree its own dependencies so the worker never has to improvise
 * (symlinking node_modules to the main checkout, building in a /tmp copy).
 * A real node_modules directory in the main checkout is APFS-cloned
 * (`cp -c`, copy-on-write, near instant); elsewhere the lockfile installs it.
 * Never a symlink. Time-boxed and best effort: a failure is logged, the run
 * goes on.
 */
export function provisionDeps(logDir: string, id: string, cwd: string, wtDir: string): void {
  const note = (n: string) => appendLedger(ledgerPath(logDir), "WORKER-NOTE", { id, note: n });
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    const main = join(root, "node_modules");
    const dest = join(wtDir, "node_modules");
    if (!existsSync(main) || lstatSync(main).isSymbolicLink() || existsSync(dest)) return;
    try {
      // an unignored node_modules would be committed by salvage; the trailing
      // slash makes git test a directory (the path does not exist yet), so a
      // dir-only `node_modules/` rule matches too
      git(wtDir, ["check-ignore", "-q", "node_modules/"]);
    } catch {
      return;
    }
    const t0 = Date.now();
    const opts = { cwd: wtDir, stdio: "ignore" as const, timeout: 180_000 };
    if (platform() === "darwin") {
      try {
        execFileSync("cp", ["-cR", main, dest], opts);
        note(`node_modules cloned (apfs) in ${Date.now() - t0}ms`);
        return;
      } catch {
        rmSync(dest, { recursive: true, force: true }); // half-copied
      }
    }
    if (existsSync(join(wtDir, "bun.lock"))) execFileSync("bun", ["install", "--frozen-lockfile"], opts);
    else if (existsSync(join(wtDir, "package-lock.json"))) execFileSync("npm", ["ci"], opts);
    else return;
    note(`node_modules installed from lockfile in ${Date.now() - t0}ms`);
  } catch (e) {
    try {
      note(`node_modules provisioning failed: ${(e as Error).message}`);
    } catch {
      /* ledger is best effort too */
    }
  }
}

/** Commits the branch collected on top of its base. */
export function commitsSince(dir: string, base: string, tip = "HEAD"): number {
  try {
    return parseInt(git(dir, ["rev-list", "--count", `${base}..${tip}`]), 10) || 0;
  } catch {
    return 0;
  }
}

/** "<hash> <subject>" of each commit the branch collected on top of its base; empty when none or unreadable. */
export function commitLines(dir: string, base: string): string[] {
  try {
    return git(dir, ["log", "--format=%h %s", `${base}..HEAD`]).split("\n").filter(Boolean);
  } catch {
    return [];
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
    s.worktreeSnapshot = info.snapshot;
  } else if (safeCommitsSince(info.dir, info.base) > 0) {
    // a failed or killed run that committed (or was salvaged) keeps its work:
    // branch and worktree stay for `pai worker merge` / `discard`
    s.branch = info.branch;
    s.commits = commitsSince(info.dir, info.base);
    s.worktreeDir = info.dir;
    s.worktreeBase = info.base;
    s.worktreeSnapshot = info.snapshot;
  } else {
    // a failed run with no commits leaves nothing to merge; the branch dies with the worktree
    for (const l of salvageNotes(s.cwd, info.dir, s.id)) console.log(l);
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
    s.worktreeSnapshot = null;
  }
  saveStatus(logDir, s);
  invalidatePendingCache(logDir, s.cwd);
  return s;
}

function safeCommitsSince(dir: string, base: string): number {
  try {
    return commitsSince(dir, base);
  } catch {
    return 0;
  }
}

/**
 * Salvage for an exit path (run finaliser, kill signal): commit whatever the
 * worker left uncommitted, log WORKER-SALVAGE, never throw. Bounded by
 * `timeoutMs` per git call. Returns the committed paths.
 */
export function salvageOnExit(
  ledger: string,
  id: string,
  label: string,
  wtDir: string,
  timeoutMs?: number
): string[] {
  try {
    const { committed, skipped } = salvageUncommitted(wtDir, label, timeoutMs);
    if (committed.length) appendLedger(ledger, "WORKER-SALVAGE", { id, paths: committed.join(","), skipped: skipped.length });
    if (skipped.length) appendLedger(ledger, "WORKER-NOTE", { id, note: `salvage skipped: ${skipped.join("; ")}` });
    return committed;
  } catch (e) {
    try {
      appendLedger(ledger, "WORKER-NOTE", { id, note: `salvage failed: ${(e as Error).message}` });
    } catch {
      /* best effort */
    }
    return [];
  }
}

/** Directories that never hold knowledge, even in an allowed text extension (a .md inside node_modules is not a note). */
export const KNOWLEDGE_IGNORE_NAMES = ["node_modules", "dist", ".pai-scratch", "coverage", ".DS_Store", ".turbo", ".cache"];

/** Text knowledge by extension: salvage is for knowledge, so only these ride back to the checkout. A gitignored build product (Obsidian/main.js, 2026-10-27) must not. */
const KNOWLEDGE_SUFFIXES = [".md", ".markdown", ".txt", ".org", ".rst"];

function isKnowledgeFile(rel: string): boolean {
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => KNOWLEDGE_IGNORE_NAMES.includes(p))) return false;
  return KNOWLEDGE_SUFFIXES.some((x) => parts[parts.length - 1]?.endsWith(x));
}

/**
 * Gitignored files in the worktree that may carry knowledge (Notes/ and kin):
 * `git status --ignored` entries with a knowledge extension, minus the
 * never-knowledge directories. An allowlist by extension — a blacklist can
 * never know every project's build products.
 */
export function ignoredKnowledge(wtDir: string): string[] {
  try {
    return git(wtDir, ["status", "--porcelain", "--ignored", "--untracked-files=all", "-z"])
      .split("\0")
      .filter((l) => l.startsWith("!! "))
      .map((l) => l.slice(3))
      .filter((p) => !p.endsWith("/") && isKnowledgeFile(p));
  } catch {
    return [];
  }
}

export interface SalvageIgnoredResult {
  lines: string[];
  failed: string[];
}

/**
 * Copy the worktree's ignored knowledge files into the original checkout before
 * the worktree is removed (nothing else carries them).
 * Never overwrites: a name that exists with different content gets
 * `<name>.<id>.md`; identical content is skipped. One line per file.
 */
export function salvageIgnored(cwd: string, wtDir: string, id: string): SalvageIgnoredResult {
  const lines: string[] = [];
  const failed: string[] = [];
  if (!existsSync(wtDir)) return { lines, failed };
  for (const rel of ignoredKnowledge(wtDir)) {
    try {
      const src = join(wtDir, rel);
      if (!lstatSync(src).isFile()) continue;
      const data = readFileSync(src);
      let dest = join(cwd, rel);
      let outRel = rel;
      if (existsSync(dest)) {
        if (readFileSync(dest).equals(data)) continue;
        outRel = `${rel}.${id}.md`;
        dest = join(cwd, outRel);
        if (existsSync(dest) && readFileSync(dest).equals(data)) continue;
        lines.push(`salvaged ${outRel} from worker ${id} (${rel} already exists with different content)`);
      } else {
        lines.push(`salvaged ${rel} from worker ${id}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    } catch {
      lines.pop();
      failed.push(rel);
    }
  }
  return { lines, failed };
}

/** `salvageIgnored` for the merge path: best effort, returns the lines only. */
export function salvageNotes(cwd: string, wtDir: string, id: string): string[] {
  return salvageIgnored(cwd, wtDir, id).lines;
}

/** What a worker worktree carries that nothing else does. */
export interface Knowledge {
  /** commits not in main by patch content */
  commits: string[];
  /** uncommitted tracked or untracked paths */
  dirty: string[];
  /** gitignored knowledge files */
  ignored: string[];
  /** written or edited per the transcript, neither committed nor present */
  missing: string[];
}

/** Files the transcript says the worker wrote or edited inside `dir` (absolute paths). */
export function transcriptWrites(logDir: string, id: string, dir: string): string[] {
  const out = new Set<string>();
  let raw = "";
  try {
    raw = readFileSync(join(logDir, `${id}.jsonl`), "utf8");
  } catch {
    return [];
  }
  const roots = [resolve(dir)];
  try {
    roots.push(realpathSync(dir));
  } catch {
    // dir gone
  }
  for (const line of raw.split("\n")) {
    if (!line.includes("tool_use")) continue;
    try {
      const ev = JSON.parse(line) as { message?: { content?: unknown } };
      const content = ev.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as { type?: string; name?: string; input?: { file_path?: string } }[]) {
        if (b?.type !== "tool_use" || !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(b.name ?? "")) continue;
        const fp = b.input?.file_path;
        if (typeof fp !== "string") continue;
        const abs = resolve(fp);
        if (roots.some((r) => abs.startsWith(r + sep))) out.add(abs);
      }
    } catch {
      // not json
    }
  }
  return [...out];
}

/** Main-branch ref to compare worker commits against. */
function mainRef(dir: string): string {
  for (const ref of ["main", "master"]) {
    try {
      git(dir, ["rev-parse", "--verify", "-q", `refs/heads/${ref}`]);
      return ref;
    } catch {
      // try next
    }
  }
  return "HEAD";
}

/**
 * What the worktree carries: unmerged commits (git cherry "+"), uncommitted
 * changes, ignored knowledge files, and files the transcript says the worker
 * wrote that are neither committed nor present any more.
 */
export function worktreeKnowledge(logDir: string, id: string, dir: string, base?: string): Knowledge {
  const k: Knowledge = { commits: [], dirty: [], ignored: [], missing: [] };
  try {
    k.commits = git(dir, ["cherry", base ?? mainRef(dir), "HEAD"])
      .split("\n")
      .filter((l) => l.startsWith("+ "))
      .map((l) => l.slice(2));
  } catch {
    // no comparable base
  }
  try {
    k.dirty = uncommittedPaths(dir);
  } catch {
    // not a worktree
  }
  k.ignored = ignoredKnowledge(dir);
  const root = resolve(dir);
  for (const abs of transcriptWrites(logDir, id, dir)) {
    if (existsSync(abs)) continue;
    const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
    try {
      git(dir, ["cat-file", "-e", `HEAD:${rel}`]);
    } catch {
      k.missing.push(rel);
    }
  }
  return k;
}

/** One-line-per-category report of a knowledge check. */
export function formatKnowledge(k: Knowledge): string[] {
  const out: string[] = [];
  if (k.commits.length) out.push(`${k.commits.length} commit(s) not in main`);
  if (k.dirty.length) out.push(`${k.dirty.length} uncommitted: ${k.dirty.slice(0, 5).join(", ")}`);
  if (k.ignored.length) out.push(`${k.ignored.length} ignored knowledge file(s): ${k.ignored.slice(0, 5).join(", ")}`);
  if (k.missing.length) out.push(`written but missing: ${k.missing.join(", ")}`);
  return out;
}

/** Remove a worktree directory from git's books and the filesystem. */
function removeWorktree(cwd: string, dir: string, force: boolean): void {
  // one-time tests die with the tree: a worker's .pai-scratch/ (gitignored,
  // never committed) is discarded here on merge, discard and gc alike
  try {
    rmSync(join(dir, ".pai-scratch"), { recursive: true, force: true });
  } catch {
    // best effort: a leftover scratch dir is gitignored and goes with the tree
  }
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
export function uncommittedPaths(wtDir: string, timeoutMs?: number): string[] {
  const tracked = git(wtDir, ["diff", "--name-only", "HEAD"], timeoutMs).split("\n").filter(Boolean);
  const untracked = git(wtDir, ["ls-files", "--others", "--exclude-standard"], timeoutMs)
    .split("\n")
    .filter(Boolean);
  return [...tracked, ...untracked];
}

/**
 * True when `wtDir`/`relPath` is a symlink whose target resolves outside
 * `wtDir` — e.g. a worker's `node_modules -> <main checkout>/node_modules`
 * convenience link. A `.gitignore` using `dir/` (directories only) does not
 * ignore such a link, so it turns up as untracked; staging and merging it
 * lets git replace the real directory on the other side with a symlink to
 * itself. Never a candidate for salvage.
 */
function symlinkEscapesWorktree(wtDir: string, relPath: string): boolean {
  const full = join(wtDir, relPath);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return false; // vanished; nothing to skip
  }
  if (!stat.isSymbolicLink()) return false;
  const target = readlinkSync(full);
  const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(full), target);
  const realTarget = existsSync(resolvedTarget) ? realpathSync(resolvedTarget) : resolvedTarget;
  const realWtDir = realpathSync(wtDir);
  return realTarget !== realWtDir && !realTarget.startsWith(realWtDir + sep);
}

export interface SalvageResult {
  /** Paths committed onto the branch. */
  committed: string[];
  /** Human-readable notes for paths left on disk, uncommitted, and why. */
  skipped: string[];
}

/**
 * Commit a worktree's uncommitted changes to its branch so the merge carries
 * them. `git merge` only moves committed work, so a worker that stopped
 * without committing would lose its edits to `worktree remove` — exactly
 * what happened live on 2026-09-17. Returns the salvaged paths, empty when
 * the worktree is clean. A symlink pointing outside the worktree (see
 * `symlinkEscapesWorktree`) is never staged; it is left on disk and reported
 * as skipped instead. A failed commit throws with the worktree untouched:
 * its edits are still on disk, so nothing is lost.
 */
export function salvageUncommitted(wtDir: string, label: string, timeoutMs?: number): SalvageResult {
  const paths = uncommittedPaths(wtDir, timeoutMs);
  if (!paths.length) return { committed: [], skipped: [] };
  const skipped: string[] = [];
  // tracked files gone from disk but not staged for removal: the worker never
  // ran `git rm`, so the absence is not its decision (see MAX_SALVAGE_DELETES)
  const missing = new Set(git(wtDir, ["ls-files", "--deleted"], timeoutMs).split("\n").filter(Boolean));
  const toStage: string[] = [];
  for (const p of paths) {
    if (missing.has(p)) {
      skipped.push(`${p} (missing, not committed)`);
    } else if (symlinkEscapesWorktree(wtDir, p)) {
      skipped.push(`symlink ${p} -> ${readlinkSync(join(wtDir, p))} (points outside the worktree)`);
    } else if (p === "node_modules" || p.startsWith("node_modules/")) {
      skipped.push(`${p} (node_modules is never committed)`);
    } else {
      toStage.push(p);
    }
  }
  if (!toStage.length) return { committed: [], skipped };
  try {
    // --ignore-removal: additions and modifications only. Deletions the worker
    // staged itself (git rm) are already in the index and ride along.
    const excludes = paths.filter((p) => !toStage.includes(p)).map((p) => `:(exclude,literal)${p}`);
    git(wtDir, ["add", "--ignore-removal", "--", ".", ...excludes], timeoutMs);
    const deleted = git(wtDir, ["diff", "--cached", "--diff-filter=D", "--name-only"], timeoutMs).split("\n").filter(Boolean);
    if (deleted.length > MAX_SALVAGE_DELETES) {
      git(wtDir, ["reset", "-q"], timeoutMs);
      throw new Error(`salvage would delete ${deleted.length} tracked files (${deleted.slice(0, 5).join(", ")}, ...), refused`);
    }
    git(wtDir, ["commit", "-m", `salvaged: ${label}`], timeoutMs);
  } catch (e) {
    throw new Error(
      `cannot salvage the uncommitted changes in ${wtDir} — ${(e as Error).message}; ` +
        `nothing was lost: commit them there by hand, then re-run merge`
    );
  }
  return { committed: toStage, skipped };
}

/**
 * Refuse a merge whose branch adds or changes a top-level `node_modules` of
 * any type (a worker's own commit of its symlink included): merging it would
 * replace the checkout's real directory. Both merge paths call this.
 */
export function assertNoNodeModules(cwd: string, from: string, branch: string, id: string): void {
  if (git(cwd, ["diff", "--name-only", from, branch, "--", "node_modules"])) {
    throw new Error(
      `worker ${id}: branch ${branch} commits node_modules, which would replace the checkout's real directory. ` +
        `Remove it on the branch (git rm -r --cached node_modules, amend), then re-run merge`
    );
  }
}

/** A salvage commit that deletes more tracked files than this is refused. */
const MAX_SALVAGE_DELETES = 5;

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
    maxBuffer: GIT_MAX_BUFFER,
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

/**
 * Never remove a worktree that still holds uncommitted changes — except a
 * symlink escaping the worktree (see `symlinkEscapesWorktree`): it was
 * deliberately left uncommitted by `salvageUncommitted`, and deleting the
 * link itself touches nothing outside the worktree.
 */
export function assertWorktreeClean(wtDir: string, id: string): void {
  const leftover = uncommittedPaths(wtDir).filter((p) => !symlinkEscapesWorktree(wtDir, p));
  if (leftover.length) {
    throw new Error(
      `worker ${id}: the worktree ${wtDir} still holds uncommitted changes ` +
        `(${leftover.join(", ")}) — it was NOT removed; commit or copy them by hand, then re-run merge`
    );
  }
}

/** Blob sha of `path` at `rev` in `cwd`, or null when it does not exist there. */
function blobAt(cwd: string, rev: string, path: string): string | null {
  try {
    return git(cwd, ["rev-parse", "--verify", "-q", `${rev}:${path}`]);
  } catch {
    return null;
  }
}

/** Blob sha of `path` as it sits on disk in `cwd`, or null when it is absent. */
function workingBlob(cwd: string, path: string): string | null {
  if (!existsSync(join(cwd, path))) return null;
  try {
    return git(cwd, ["hash-object", "--", path]);
  } catch {
    return null;
  }
}

/**
 * Refuse a snapshot merge when the checkout differs from the snapshot the
 * worker branched from, for any path the branch touched: the operator edited
 * it, or it was created/deleted since — applying the branch's diff on top
 * would silently discard that. Absent-in-both counts as equal.
 */
function assertNoSnapshotDrift(cwd: string, snapshot: string, paths: string[], id: string): void {
  const drifted = paths
    .filter((p) => blobAt(cwd, snapshot, p) !== workingBlob(cwd, p))
    .sort();
  if (!drifted.length) return;
  throw new Error(
    `worker ${id}: the checkout ${cwd} has changed since the worktree's snapshot in paths the branch touches: ` +
      `${drifted.join(", ")}. Resolve by hand, then re-run: pai worker merge ${id}. ` +
      `No merge was made; the worktree was kept.`
  );
}

/**
 * `pai worker merge <id>` for a snapshot-based worktree (see `addWorktree`):
 * git's own merge only moves committed history, and the snapshot commit was
 * never on any branch reachable from `cwd`'s HEAD, so there is nothing to
 * `git merge` here. Instead the worker's own changes — `git diff --binary
 * <snapshot> <branch>` — are applied straight onto the checkout's working
 * tree as uncommitted edits, exactly like the uncommitted state the worker
 * started from. Works even if `cwd`'s HEAD moved since the snapshot: the
 * diff is applied to files, not merged into a tree.
 */
function mergeSnapshotWorker(
  logDir: string,
  id: string,
  st: WorkerStatus & Required<Pick<WorkerStatus, "branch" | "worktreeDir">>,
  noCommit = false,
  verify?: string
): string {
  const snapshot = st.worktreeBase!;
  const branch = st.branch!;
  const worktreeDir = st.worktreeDir!;
  const salvage = existsSync(worktreeDir)
    ? salvageUncommitted(worktreeDir, st.label || UNLABELED)
    : { committed: [], skipped: [] };
  const incoming = parseInt(git(st.cwd, ["rev-list", "--count", `${snapshot}..${branch}`]), 10) || 0;
  if (incoming <= 0) {
    throw new Error(
      `worker ${id}: branch ${branch} has no commits beyond its snapshot to merge. ` +
        `The worktree ${worktreeDir} was NOT removed — uncommitted work there would be destroyed. ` +
        (st.escalatedTo && escalationState(logDir, st) === "superseded"
          ? `It was superseded by the merged escalated run ${st.escalatedTo}; drop it with: pai worker discard ${id}`
          : `Commit it yourself, or drop everything with: pai worker discard ${id}`)
    );
  }
  const changedPaths = git(st.cwd, ["diff", "--name-only", snapshot, branch]).split("\n").filter(Boolean);
  assertNoNodeModules(st.cwd, snapshot, branch, id);
  assertNoSnapshotDrift(st.cwd, snapshot, changedPaths, id);
  const diff = execFileSync("git", ["-C", st.cwd, "diff", "--binary", snapshot, branch], {
    encoding: "buffer",
    timeout: 30_000,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (diff.length > 0) {
    try {
      execFileSync("git", ["-C", st.cwd, "apply", "--binary"], {
        input: diff,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string; status?: number };
      const why =
        (typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8")) ||
        err.message ||
        String(e);
      throw new Error(
        `worker ${id}: git refused to apply ${branch}'s changes to ${st.cwd} — ${why.trim()}. ` +
          `The worktree ${worktreeDir} was kept: resolve by hand, then re-run merge`
      );
    }
  }
  const revert = (): string => {
    execFileSync("git", ["-C", st.cwd, "apply", "-R", "--binary"], {
      input: diff,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return `the applied diff of ${branch}`;
  };
  const gate = gateLines(
    st.cwd,
    verify,
    revert,
    () => scanDiffForStub(git(st.cwd, ["diff", "-U0", "--no-color", snapshot, branch, "--", "src/"])),
    () => testLossOver(st.cwd, snapshot, branch)
  );
  if (noCommit) return withGate(gate, noCommitNextSteps(id, branch, worktreeDir, changedPaths));
  for (const l of salvageNotes(st.cwd, worktreeDir, id)) console.log(l);
  removeWorktree(st.cwd, worktreeDir, true);
  try {
    git(st.cwd, ["branch", "-D", branch]); // never merged by git — nothing for -d to see
  } catch {
    // already gone
  }
  const s = { ...st, merged: true };
  saveStatus(logDir, s);
  const base =
    `applied worker ${id}'s changes (branch ${branch}) to ${st.cwd} as uncommitted changes: ` +
    `${changedPaths.join(", ")} (worktree removed, branch deleted)`;
  const notes: string[] = [];
  if (salvage.committed.length) {
    notes.push(
      `salvaged ${salvage.committed.length} uncommitted change(s) onto the branch first: ${salvage.committed.join(", ")}`
    );
  }
  if (salvage.skipped.length) {
    notes.push(`skipped ${salvage.skipped.join(", ")}`);
  }
  return withGate(gate, notes.length ? `${base}; ${notes.join("; ")}` : base);
}

function noCommitNextSteps(id: string, branch: string, worktreeDir: string, paths: string[]): string {
  return (
    `applied worker ${id}'s changes (branch ${branch}) to the checkout as uncommitted changes: ${paths.join(", ")}. ` +
    `Branch and worktree ${worktreeDir} were kept. Next: review (git diff), commit, then run: pai worker gc`
  );
}

/**
 * `merge --no-commit`: apply base..branch to the checkout with a 3-way
 * `git apply`, leaving the result uncommitted. On conflict the tree is left
 * as is (markers + unmerged index entries) and the conflicted paths are listed.
 */
function applyNoCommit(cwd: string, id: string, branch: string, worktreeDir: string, base: string, paths: string[]): string {
  const diff = execFileSync("git", ["-C", cwd, "diff", "--binary", `${base}..${branch}`], {
    encoding: "buffer",
    timeout: 30_000,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C" },
  });
  try {
    execFileSync("git", ["-C", cwd, "apply", "--3way", "--binary"], {
      input: diff,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch (e) {
    const conflicted = git(cwd, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    const err = e as { stderr?: Buffer | string; message?: string; status?: number };
    const why = ((typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8")) || err.message || "").trim();
    throw new Error(
      conflicted.length
        ? `worker ${id}: applying ${branch} conflicted in ${conflicted.join(", ")}. The tree was left for you: ` +
            `resolve those paths, review, commit; branch and worktree ${worktreeDir} were kept`
        : `worker ${id}: git refused to apply ${branch} to ${cwd} — ${why}. Nothing was changed; branch and worktree were kept`
    );
  }
  return noCommitNextSteps(id, branch, worktreeDir, paths);
}

export type VerifyState = "identical" | "differs" | "missing" | "deleted";
export interface VerifyResult {
  id: string;
  ref: string;
  base: string;
  against: string;
  files: { path: string; state: VerifyState }[];
  ok: boolean;
}

/**
 * `pai worker verify <id>`: for every file the worker's branch (or its
 * refs/pai-archive/<id> archive once the branch is gone) changed since its
 * base, compare bytes with the working tree or `--against <ref>`.
 * identical = the target already holds the worker's version (a worker delete
 * counts as identical when the target lacks the file too); differs = other
 * bytes; missing = the worker's file is absent in the target; deleted = the
 * worker deleted it but the target still has it. ok = every file identical.
 */
export function verifyWorker(logDir: string, id: string, opts: { against?: string } = {}): VerifyResult {
  const st = loadStatus(logDir, id);
  if (!st) throw new Error(`no worker named "${id}"`);
  const env = { ...process.env, LC_ALL: "C" };
  const bytes = (args: string[]): Buffer | null => {
    try {
      return execFileSync("git", ["-C", st.cwd, ...args], {
        env,
        timeout: 30_000,
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
  };
  const has = (ref: string): boolean => bytes(["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== null;
  const branch = st.branch ?? worktreeBranch(id);
  const ref = [`refs/heads/${branch}`, `refs/pai-archive/${id}`].find(has);
  if (!ref) throw new Error(`worker ${id}: neither ${branch} nor refs/pai-archive/${id} exists in ${st.cwd}`);
  const base = st.worktreeSnapshot && st.worktreeBase ? st.worktreeBase : git(st.cwd, ["merge-base", "HEAD", ref]);
  const list = (bytes(["diff", "--name-status", "--no-renames", "-z", `${base}..${ref}`]) ?? Buffer.alloc(0))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const files: VerifyResult["files"] = [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    const path = list[i + 1];
    const deleted = list[i] === "D";
    const target = opts.against
      ? bytes(["show", `${opts.against}:${path}`])
      : existsSync(join(st.cwd, path))
        ? readFileSync(join(st.cwd, path))
        : null;
    let state: VerifyState;
    if (deleted) state = target ? "deleted" : "identical";
    else {
      const mine = bytes(["show", `${ref}:${path}`]);
      state = !target ? "missing" : mine && mine.equals(target) ? "identical" : "differs";
    }
    files.push({ path, state });
  }
  return { id, ref, base, against: opts.against ?? "working tree", files, ok: files.every((f) => f.state === "identical") };
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
/** A merge git refused because of conflicts; the checkout was restored, `paths` lists the conflicted files. */
export class MergeConflictError extends Error {
  constructor(message: string, readonly paths: string[]) {
    super(message);
  }
}

/**
 * A worker that detached HEAD in its worktree and committed leaves those
 * commits off its branch. When HEAD is detached and a strict descendant of the
 * branch tip, fast-forward the branch to it. Returns the adopted sha, else null.
 */
export function adoptDetachedHead(dir: string, branch: string): string | null {
  try {
    if (!existsSync(dir)) return null;
    try {
      git(dir, ["symbolic-ref", "-q", "HEAD"]);
      return null; // on a branch
    } catch {
      // detached
    }
    const head = git(dir, ["rev-parse", "HEAD"]);
    const tip = git(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    if (head === tip) return null;
    git(dir, ["merge-base", "--is-ancestor", tip, head]);
    git(dir, ["update-ref", `refs/heads/${branch}`, head, tip]);
    return head;
  } catch {
    return null; // no branch, diverged, or unreadable: nothing to adopt
  }
}

/** Merge-conflict auto-resolution settings (config keys workers.merge.generated / workers.merge.regenerate). */
export interface MergeSettings {
  generated: string[];
  regenerate: string;
  union: string[];
  verify: string;
  verifyTimeoutSec: number;
}

function mergeSettings(): MergeSettings {
  const m = loadConfig().workers?.merge;
  return { generated: m?.generated ?? [], regenerate: m?.regenerate ?? "", union: m?.union ?? [], verify: m?.verify ?? DEFAULT_VERIFY, verifyTimeoutSec: m?.verifyTimeoutSec ?? DEFAULT_VERIFY_TIMEOUT_SEC };
}

/** Glob to RegExp: `**` crosses directories, `*` and `?` stay inside one. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Does the diff from `base` to `side` only add lines (nothing removed or changed)? */
function onlyAdds(dir: string, base: string, side: string): boolean {
  const r = spawnSync("git", ["diff", "--no-index", "--numstat", "--", base, side], { cwd: dir, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
  const m = /^(\d+)\t(\d+)\t/.exec(r.stdout ?? "");
  return !!m && m[2] === "0";
}

/**
 * Resolve the conflicts of a merge in progress when every one is either in a
 * generated path (take ours, regenerate, add) or a pure-addition clash (both
 * sides only added lines: union, ours then theirs). Returns a note on success,
 * null when anything else conflicts (merge left in progress for the caller to
 * abort); throws after aborting when regeneration fails.
 */
function autoResolveMerge(cwd: string, files: string[], cfg: MergeSettings): string | null {
  const res = cfg.generated.map(globToRegExp);
  const isGen = (f: string): boolean => res.some((r) => r.test(f));
  const gen = files.filter(isGen);
  const rest = files.filter((f) => !isGen(f));
  const unionRes = cfg.union.map(globToRegExp);
  if (rest.some((f) => !unionRes.some((r) => r.test(f)))) return null;
  const tmp = mkdtempSync(join(tmpdir(), "pai-union-"));
  const unions: Array<{ file: string; content: string }> = [];
  try {
    for (const f of rest) {
      const stage = (n: number, name: string): string | null => {
        const r = spawnSync("git", ["show", `:${n}:${f}`], { cwd, encoding: "buffer", maxBuffer: GIT_MAX_BUFFER });
        if (r.status !== 0) return null;
        writeFileSync(join(tmp, name), r.stdout);
        return join(tmp, name);
      };
      const base = stage(1, "base");
      const ours = stage(2, "ours");
      const theirs = stage(3, "theirs");
      if (!base || !ours || !theirs || !onlyAdds(cwd, base, ours) || !onlyAdds(cwd, base, theirs)) return null;
      const m = spawnSync("git", ["merge-file", "-p", "--union", ours, base, theirs], { cwd, encoding: "buffer", maxBuffer: GIT_MAX_BUFFER });
      if (m.status !== 0) return null;
      unions.push({ file: f, content: m.stdout.toString("utf8") });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const notes: string[] = [];
  if (gen.length) {
    for (const f of gen) {
      try {
        git(cwd, ["checkout", "--ours", "--", f]);
      } catch {
        git(cwd, ["rm", "-q", "--cached", "--ignore-unmatch", "--", f]);
      }
    }
  }
  for (const u of unions) {
    writeFileSync(join(cwd, u.file), u.content, "utf8");
    git(cwd, ["add", "--", u.file]);
  }
  if (gen.length) {
    const r = spawnSync("sh", ["-c", cfg.regenerate], { cwd, encoding: "utf8" });
    if (!cfg.regenerate || r.status !== 0) {
      git(cwd, ["merge", "--abort"]);
      throw new Error(
        `git refused the merge: conflicts in generated paths (${gen.join(", ")}) and regeneration ` +
          (cfg.regenerate ? `\`${cfg.regenerate}\` failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(-400)}` : "is not configured (workers.merge.regenerate)") +
          "; the merge was aborted"
      );
    }
    const specs = cfg.generated.map((g) => `:(glob)${g}`);
    git(cwd, ["add", "-A", "--", ...specs]);
    const count = git(cwd, ["ls-files", "--", ...specs]).split("\n").filter(Boolean).length;
    notes.push(`regenerated ${cfg.generated.filter((g) => gen.some((f) => globToRegExp(g).test(f))).map((g) => g.replace(/\/?\*\*$/, "")).join(", ")} (${count} files)`);
  }
  for (const u of unions) notes.push(`union-merged ${u.file}`);
  return notes.join("; ");
}

export function mergeWorker(
  logDir: string,
  id: string,
  opts: { noCommit?: boolean; verify?: string; merge?: MergeSettings; verifyTests?: boolean; rebuild?: boolean; build?: BuildRunner; cliRoot?: string | null } = {}
): string {
  const st = mustHaveBranch(logDir, id);
  if (st.merged) return `worker ${id}: branch ${st.branch} already merged`;
  if (st.escalatedTo && escalationState(logDir, st) === "running") {
    throw new Error(
      `worker ${id}: escalated to ${st.escalatedTo}, which is still running from branch ${st.branch}; ` +
        `merging now would delete that branch under it. Merge ${st.escalatedTo} when it finishes.`
    );
  }
  if (st.worktreeSnapshot) return mergeSnapshotWorker(logDir, id, st, opts.noCommit, opts.verify);
  const adopted = adoptDetachedHead(st.worktreeDir!, st.branch!);
  if (adopted) console.log(`worker ${id}: adopted detached HEAD ${adopted.slice(0, 7)} into ${st.branch}`);
  // salvage first: only a commit can carry uncommitted work through the merge
  const slot = isSlotWorktree(st.worktreeDir!);
  const salvage = existsSync(st.worktreeDir!) && !slot
    ? salvageUncommitted(st.worktreeDir!, st.label || UNLABELED)
    : { committed: [], skipped: [] };
  const incoming = parseInt(git(st.cwd, ["rev-list", "--count", `HEAD..${st.branch}`]), 10) || 0;
  const reapply = incoming <= 0 ? findRevertedMerge(st.cwd, st.branch!) : null;
  if (incoming <= 0 && !reapply) {
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
  assertNoNodeModules(st.cwd, mergeBase, st.branch!, id);
  assertNoDirtyOverlap(st.cwd, incomingPaths, id, st.branch!);
  if (opts.noCommit) return applyNoCommit(st.cwd, id, st.branch!, st.worktreeDir!, mergeBase, incomingPaths);
  // static scans on the branch's own changes, before anything is committed: a failure leaves HEAD untouched
  const [scanFrom, scanTo] = reapply ? [`${reapply.merge}^1`, reapply.merge] : [mergeBase, st.branch!];
  assertStaticScans(st.cwd, scanFrom, scanTo);
  const oldHead = git(st.cwd, ["rev-parse", "HEAD"]);
  let autoNote: string | null = null;
  try {
    if (reapply) git(st.cwd, ["revert", "--no-edit", reapply.revert]);
    else git(st.cwd, ["merge", "--no-ff", st.branch!, "-m", `merge worker ${id} (${st.label})`]);
  } catch (e) {
    let files: string[] = [];
    let inProgress = false;
    try {
      inProgress = existsSync(resolve(st.cwd, git(st.cwd, ["rev-parse", "--git-path", "MERGE_HEAD"])));
      if (inProgress) files = git(st.cwd, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    } catch {
      /* fall through to the generic message */
    }
    let autoErr: Error | null = null;
    if (inProgress && files.length) {
      try {
        autoNote = autoResolveMerge(st.cwd, files, opts.merge ?? mergeSettings());
        if (autoNote !== null) git(st.cwd, ["commit", "-q", "-m", `merge worker ${id} (${st.label}); auto-resolved: ${autoNote}`]);
      } catch (err) {
        autoErr = err as Error;
        autoNote = null;
      }
    }
    if (inProgress && autoNote === null) {
      try { git(st.cwd, ["merge", "--abort"]); } catch { /* already aborted */ }
      if (git(st.cwd, ["rev-parse", "HEAD"]) !== oldHead || git(st.cwd, ["status", "--porcelain", "--untracked-files=no"])) {
        throw new Error(`worker ${id}: git merge --abort left ${st.cwd} not at ${oldHead}; inspect it before retrying`);
      }
    }
    if (autoErr && /the merge was aborted$/.test(autoErr.message)) throw autoErr;
    if (autoNote === null) {
    const msg =
      `worker ${id}: git refused the merge of ${st.branch}` +
        (files.length
          ? ` — conflict in ${files.join(", ")}${autoErr ? ` (auto-resolution failed: ${autoErr.message.split("\n")[0].slice(0, 200)})` : ""}: merge main into the worker branch in its kept worktree (${st.worktreeDir}), resolve, then re-run pai worker merge ${id}`
          : ` — ${(e as Error).message}. The worktree ${st.worktreeDir} was kept: resolve the problem, then re-run pai worker merge ${id}`);
    throw files.length ? new MergeConflictError(msg, files) : new Error(msg);
    }
  }
  const verifyLine = gateLines(
    st.cwd,
    opts.verify,
    () => revertMerge(st.cwd, oldHead),
    () => null
  );
  let related: RelatedResult | null = null;
  let mergeCommit = "";
  if (opts.verifyTests !== false) {
    const cfg = opts.merge ?? mergeSettings();
    mergeCommit = git(st.cwd, ["rev-parse", "HEAD"]);
    related = runRelatedTests(st.cwd, oldHead, { ...cfg }, git);
    appendLedger(ledgerPath(logDir), "WORKER-MERGE-TESTS", {
      id,
      status: related.status,
      result: related.line.replace(/\s+/g, " ").slice(0, 300),
      ...(related.flakyLogs?.length ? { flakyLog: related.flakyLogs.join(",") } : {}),
    });
    if (related.output) void growthAlarm(logDir, st.cwd, related.output);
    // "failed" already survived the serial re-run (flaky-under-load is its own status): revert like the other gates
    if (related.status === "failed" && process.env.PAI_MERGE_KEEP_ON_FAIL !== "1") {
      const files = related.failing.length ? related.failing.join(", ") : related.line;
      throw new Error(
        `related tests failed: ${files}: reverted ${revertMerge(st.cwd, oldHead)}; branch kept: fix it and merge again (PAI_MERGE_KEEP_ON_FAIL=1 keeps the merge)`
      );
    }
  }
  if (existsSync(st.worktreeDir!) && !slot) assertWorktreeClean(st.worktreeDir!, id);
  // force: assertWorktreeClean already confirmed nothing but a skipped
  // outside-pointing symlink (if anything) remains uncommitted
  if (!slot) for (const l of salvageNotes(st.cwd, st.worktreeDir!, id)) console.log(l);
  if (!slot) removeWorktree(st.cwd, st.worktreeDir!, true);
  // a slot tree survives the merge: its scratch dir (one-time tests) is discarded explicitly
  if (slot) {
    try {
      rmSync(join(st.worktreeDir!, ".pai-scratch"), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  let branchGone = true;
  try {
    if (slot) {
      // For slot worktrees, we need to ensure we're not on the branch before deleting it
      try {
        const currentBranch = git(st.worktreeDir!, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (currentBranch === st.branch) {
          git(st.worktreeDir!, ["checkout", "-q", "--detach"]);
        }
      } catch {
        // If we cannot determine or change the branch, proceed with deletion anyway
      }
      git(st.cwd, ["branch", "-D", st.branch!]);
    } else {
      git(st.cwd, ["branch", "-d", st.branch!]);
    }
  } catch {
    branchGone = false; // -d refuses anything not fully merged; keep the branch, say so
  }
  const s = { ...st, merged: true };
  saveStatus(logDir, s);
  invalidatePendingCache(logDir, st.cwd);
  const base = `merged ${st.branch} into ${st.cwd} (${slot ? "slot worktree kept" : "worktree removed"}${branchGone ? ", branch deleted" : "; branch kept: git refused -d"})`;
  const notes: string[] = [];
  if (salvage.committed.length) {
    notes.push(`salvaged ${salvage.committed.length} uncommitted change(s): ${salvage.committed.join(", ")}`);
  }
  if (salvage.skipped.length) {
    notes.push(`skipped ${salvage.skipped.join(", ")}`);
  }
  if (autoNote) notes.unshift(`auto-resolved conflicts: ${autoNote}`);
  const merged = notes.length ? `${base}; ${notes.join("; ")}` : base;
  const text = withGate(verifyLine, merged);
  if (!related) return withBuild(text, rebuildDist(logDir, id, st.cwd, opts));
  if (related.status === "failed") throw new RelatedTestsFailedError([text, related.line, ...failureHints(related, mergeCommit)].join("\n"));
  return withBuild(`${text}\n${related.line}`, rebuildDist(logDir, id, st.cwd, opts));
}

const withBuild = (text: string, build: string | null): string => (build ? `${text}\n${build}` : text);

export interface BuildResult { ok: boolean; ms: number; tail: string }
/** Runs `npm run build` in a directory; injectable for tests. */
export type BuildRunner = (cwd: string) => BuildResult;

/** Environment keys a build needs; everything else (tokens, API keys) stays out. */
const BUILD_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "NODE_ENV", "NODE_OPTIONS", "TERM"];

function defaultBuild(cwd: string): BuildResult {
  const env: NodeJS.ProcessEnv = {};
  for (const k of BUILD_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  const t0 = Date.now();
  const r = spawnSync("npm", ["run", "build"], { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
  const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" | ").slice(-400);
  return { ok: r.status === 0 && !r.error, ms: Date.now() - t0, tail };
}

/** Package root of the running CLI (dist/cli/index.mjs two levels up), symlinks resolved; null when unknown. */
function runningCliRoot(): string | null {
  try {
    const entry = process.argv[1];
    return entry ? dirname(dirname(dirname(realpathSync(entry)))) : null;
  } catch {
    return null;
  }
}

/**
 * A merge into the repo the running `pai` comes from leaves dist/ stale: the installed CLI, daemon and router keep
 * running old code. Rebuild it. Returns the line to print, or null when no build applies (other repo, opt-out).
 * A failed build never reverts the merge.
 */
function rebuildDist(
  logDir: string,
  id: string,
  target: string,
  opts: { rebuild?: boolean; build?: BuildRunner; cliRoot?: string | null }
): string | null {
  if (opts.rebuild === false || loadConfig().workers?.merge?.rebuild === false) return null;
  let same = false;
  try {
    const root = opts.cliRoot === undefined ? runningCliRoot() : opts.cliRoot;
    same = !!root && realpathSync(root) === realpathSync(target);
  } catch {
    same = false;
  }
  if (!same) return null;
  let res: BuildResult;
  try {
    res = (opts.build ?? defaultBuild)(target);
  } catch (e) {
    res = { ok: false, ms: 0, tail: (e as Error).message };
  }
  appendLedger(ledgerPath(logDir), "WORKER-MERGE-BUILD", { id, ok: String(res.ok), ms: res.ms, tail: res.tail.replace(/\s+/g, " ").slice(-300) });
  if (res.ok) return "build: ok (dist rebuilt; the daemon restarts itself on the new build, the router swaps gaplessly within ~30 s)";
  const last = res.tail.split(/\s*\|\s*|\n/).filter(Boolean).pop() ?? "no output";
  return `build: FAILED — dist unchanged: ${last}`;
}

/** The merge stands but its related tests failed; the CLI exits 3 with the message (merge summary, result, hints). */
export class RelatedTestsFailedError extends Error {}

/** Stub and test-loss scans over `from..to`; throws before any merge exists, so the advised re-run works. */
export function assertStaticScans(cwd: string, from: string, to: string): void {
  const backups = git(cwd, ["diff", "--name-only", "--diff-filter=A", from, to])
    .split("\n")
    .filter((f) => /(-e|\.orig|\.rej|\.bak|~|\.swp)$/.test(f));
  if (backups.length) {
    throw new Error(`backup files added: ${backups.join(", ")}: nothing merged; remove them (BSD \`sed -i -e\` leaves file-e) and re-commit; the worker branch is kept`);
  }
  const hit = scanDiffForStub(git(cwd, ["diff", "-U0", "--no-color", from, to, "--", "src/"]));
  if (hit) throw new Error(`stub scan failed: ${hit}: nothing merged; the worker branch is kept`);
  if (process.env.PAI_MERGE_ALLOW_TEST_LOSS === "1") return;
  const loss = testLossOver(cwd, from, to);
  if (loss) {
    throw new Error(
      `test scan failed: ${loss}: nothing merged; the worker branch is kept (a deliberate removal: re-run the merge with PAI_MERGE_ALLOW_TEST_LOSS=1)`
    );
  }
}

/** The merge of `branch` in HEAD's history and the revert commit the gate made of it, when both exist; else null. */
function findRevertedMerge(cwd: string, branch: string): { merge: string; revert: string } | null {
  try {
    const tip = git(cwd, ["rev-parse", branch]);
    const merge = git(cwd, ["rev-list", "--merges", "--parents", "HEAD"])
      .split("\n")
      .map((l) => l.split(" "))
      .find((p) => p[2] === tip)?.[0];
    if (!merge) return null;
    const revert = git(cwd, ["log", "--format=%H", "-n", "1", `--grep=This reverts commit ${merge}`, `${merge}..HEAD`]);
    return revert ? { merge, revert } : null;
  } catch {
    return null;
  }
}

const withGate = (gate: string, msg: string): string => (gate ? `${gate}\n${msg}` : msg);

/** Marker a timed gate writes to stderr; the plan runner (plan-deps.ts) reads these lines and strips them. */
export const GATE_MARK = "\u0001pai-gate ";

/** The commands of a `a && b && c` gate; one command when it holds quoting, pipes, `;`, `||`, or a `cd`/`export`/assignment step that a plain split would break. */
export function splitGate(verify: string): string[] {
  if (/["'`|;()\\]/.test(verify)) return [verify];
  const cmds = verify.split(/\s*&&\s*/).map((c) => c.trim()).filter(Boolean);
  // cwd and env changes only live inside one shell: such a chain must run whole
  if (cmds.some((c) => /^(cd|export|unset|set|source|\.|\w+=\S*)(\s|$)/.test(c))) return [verify];
  return cmds;
}

/** Run the gate one command at a time, reporting each start and end as marker lines; stops at the first failure. */
function runGateTimed(cwd: string, verify: string, env: NodeJS.ProcessEnv): number | null {
  const mark = (o: object): void => void process.stderr.write(`${GATE_MARK}${JSON.stringify(o)}\n`);
  const cmds = splitGate(verify);
  const t0 = Date.now();
  mark({ ev: "gate-start", commands: cmds });
  let status: number | null = 0;
  for (let i = 0; i < cmds.length && status === 0; i++) {
    mark({ ev: "cmd-start", i, cmd: cmds[i] });
    const c0 = Date.now();
    status = spawnSync("sh", ["-c", cmds[i]], { cwd, env, stdio: "inherit" }).status;
    mark({ ev: "cmd-end", i, cmd: cmds[i], ms: Date.now() - c0, ok: status === 0 });
  }
  mark({ ev: "gate-end", ok: status === 0, ms: Date.now() - t0 });
  return status;
}

/**
 * The one gate both merge kinds run after the change is in the checkout: the
 * --verify command (when given), then the stub scan. A failure calls `revert`
 * (which undoes exactly what the merge applied and returns what it reverted)
 * and throws; branch and worktree stay so the work can be fixed and re-merged.
 */
function gateLines(
  cwd: string,
  verify: string | undefined, revert: () => string,
  findStub: () => string | null,
  findTestLoss: () => string | null = () => null,
  findDuplicates: () => string | null = () => null
): string {
  const lines: string[] = [];
  if (verify) {
    const env = { ...process.env };
    delete env.PAI_WORKER;
    delete env.PAI_WORKER_ORCHESTRATOR;
    // one test run per machine slot; the verify command's own test runs (wrapped by the guard) reuse it
    const lease = holdsTestSlot() ? null : acquireTestSlotSync();
    if (lease) env[SLOT_HELD_ENV] = "1";
    let status: number | null;
    try {
      status = process.env.PAI_GATE_EVENTS === "1" ? runGateTimed(cwd, verify, env) : spawnSync("sh", ["-c", verify], { cwd, env, stdio: "inherit" }).status;
    } finally {
      lease?.release();
    }
    if (status !== 0) throw new Error(`verify failed (exit ${status ?? 1}): reverted ${revert()}; the worker branch is kept`);
    lines.push(`verify passed: ${verify}`);
  }
  const hit = findStub();
  if (hit) throw new Error(`stub scan failed: ${hit}: reverted ${revert()}; the worker branch is kept`);
  if (process.env.PAI_MERGE_ALLOW_TEST_LOSS !== "1") {
    const loss = findTestLoss();
    if (loss) {
      throw new Error(
        `test scan failed: ${loss}: reverted ${revert()}; the worker branch is kept (a deliberate removal: re-run the merge with PAI_MERGE_ALLOW_TEST_LOSS=1)`
      );
    }
  }
  if (process.env.PAI_MERGE_ALLOW_DUPLICATES !== "1") {
    const dup = findDuplicates();
    if (dup) {
      throw new Error(
        `${dup.startsWith("duplicate gate could not run") ? dup : `duplicate-code gate failed: ${dup}`}: reverted ${revert()}; the worker branch is kept (extract the shared function and re-merge)`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Run the --verify command on the merged tree (stdio inherited, worker env
 * markers removed). Non-zero: revert the merge with a new commit (never a
 * reset — the checkout is shared) and throw; branch and worktree stay so the
 * work can be fixed and re-merged.
 */
/** Tell the merging session when the project's suite outgrew its governed core (src/testgov/alarm.ts); never throws. */
async function growthAlarm(logDir: string, repo: string, output: string): Promise<void> {
  try {
    const { checkGrowth } = await import("../testgov/alarm.js");
    const text = checkGrowth(repo, output);
    if (!text) return;
    process.stderr.write(text + "\n");
    const { aibrokerMessenger, originFromEnv } = await import("./run-events.js");
    await aibrokerMessenger(logDir).toSession(originFromEnv(), text);
  } catch {
    /* the alarm is advisory */
  }
}

export function runVerify(cwd: string, cmd: string, oldHead: string): string {
  return gateLines(cwd, cmd, () => revertMerge(cwd, oldHead), () => null);
}

/** Revert the merge just made (a new commit, never a reset — the checkout is shared); returns the reverted head. */
function revertMerge(cwd: string, oldHead: string): string {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const isMergeCommit = git(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").length > 2;
  git(cwd, isMergeCommit ? ["revert", "-m", "1", "--no-edit", head] : ["revert", "--no-edit", `${oldHead}..HEAD`]);
  return head;
}

/** Lines a merge may not add under src/: placeholders that pass tsc and tests but do nothing. */
export const STUB_PATTERN = /TODO: [Ii]mplement|Promise\.resolve\(0\)\s*\/\/\s*TODO|throw new Error\(["']not implemented/;

/** First `file:line` that the merge (oldHead..HEAD) adds under src/ matching STUB_PATTERN, or null. */
export function findAddedStub(cwd: string, oldHead: string): string | null {
  return scanDiffForStub(git(cwd, ["diff", "-U0", "--no-color", oldHead, "HEAD", "--", "src/"]));
}

/** Test files may carry the stub pattern as a fixture (they test the scan itself). */
export function isTestPath(file: string): boolean {
  return /\.(test|spec)\./.test(file) || /(^|\/)(__tests__|tests?)\//.test(file);
}

export function scanDiffForStub(diff: string): string | null {
  let file = "";
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
    else if (l.startsWith("@@")) line = parseInt(/\+(\d+)/.exec(l)?.[1] ?? "0", 10);
    else if (l.startsWith("+")) {
      if (!isTestPath(file) && STUB_PATTERN.test(l)) return `${file}:${line}`;
      line++;
    }
  }
  return null;
}

const TEST_CASE = /^\s*(it|test)(\.\w+)?\(/;

/**
 * First test file in the diff (-U0, no renames) whose net loss of test cases
 * exceeds the total net gain across all test files (moving cases is fine), as
 * "<file> loses N test case(s)"; null when none. A deleted file loses all its cases.
 * With `kept` (a governed prune: the same change edits tests/KEPT.md) only files in it can lose cases.
 */
export function scanDiffForTestLoss(diff: string, kept?: ReadonlySet<string>): string | null {
  const net = new Map<string, number>();
  let file = "";
  for (const l of diff.split("\n")) {
    const h = /^diff --git a\/.* b\/(.*)$/.exec(l);
    if (h) file = h[1];
    else if (!isTestPath(file) || l.startsWith("+++") || l.startsWith("---")) continue;
    else if (l.startsWith("+") && TEST_CASE.test(l.slice(1))) net.set(file, (net.get(file) ?? 0) + 1);
    else if (l.startsWith("-") && TEST_CASE.test(l.slice(1))) net.set(file, (net.get(file) ?? 0) - 1);
  }
  let gain = 0;
  for (const n of net.values()) if (n > 0) gain += n;
  for (const [f, n] of net) if (n < 0 && -n > gain && (!kept || kept.has(f))) return `${f} loses ${-n} test case(s)`;
  return null;
}

/** Test-loss scan over `from..to`; a change that edits tests/KEPT.md is a governed prune and only KEPT.md files are protected. */
export function testLossOver(cwd: string, from: string, to: string): string | null {
  const diff = git(cwd, ["diff", "-U0", "--no-color", "--no-renames", from, to]);
  if (!git(cwd, ["diff", "--name-only", from, to, "--", "tests/KEPT.md"]).trim()) return scanDiffForTestLoss(diff);
  let ledger = "";
  try {
    ledger = git(cwd, ["show", `${to}:tests/KEPT.md`]);
  } catch {
    // KEPT.md deleted: nothing is protected
  }
  const kept = new Set<string>();
  for (const l of ledger.split("\n")) {
    const m = /^\|\s*(\S+)\s*\|/.exec(l);
    if (m) kept.add(m[1]);
  }
  return scanDiffForTestLoss(diff, kept);
}

/** Built-in stub scan after a merge: a hit reverts it exactly like a failed verify. */
export function stubScan(cwd: string, oldHead: string): string {
  return gateLines(cwd, undefined, () => revertMerge(cwd, oldHead), () => findAddedStub(cwd, oldHead), () =>
    testLossOver(cwd, oldHead, "HEAD"),
    () => findNewDuplicates(cwd)
  );
}

/**
 * Run scripts/check-duplicates.mjs in the merged tree: its report when a new clone was added, else null
 * (also null when the repo has no such script). Fails closed: exit 2 (jscpd missing or crashed) is a
 * report too, "duplicate gate could not run: <reason> — run npm install in <cwd>".
 */
export function findNewDuplicates(cwd: string): string | null {
  if (!existsSync(join(cwd, "scripts", "check-duplicates.mjs"))) return null;
  const r = spawnSync("node", ["scripts/check-duplicates.mjs"], { cwd, encoding: "utf8" });
  if (r.status === 0) return null;
  const text = (r.stderr || r.stdout || String(r.error ?? "")).trim().split("\n").join("; ");
  if (r.status !== 2) return text;
  return `duplicate gate could not run: ${text.replace(/^duplicate scan could not run:?\s*/, "")} — run npm install in ${cwd}`;
}

/** First repo among the status's worktree, cwd and the invocation cwd that has refs/heads/<branch>. */
function repoHoldingBranch(st: WorkerStatus): string | null {
  for (const d of new Set([st.worktreeDir, st.cwd, process.cwd()].filter((x): x is string => !!x && existsSync(x)))) {
    const repo = commonDir(d);
    if (!repo) continue;
    try {
      git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${st.branch}`]);
      return repo;
    } catch {
      continue;
    }
  }
  return null;
}

/** Keep the branch tip under refs/pai-archive/<id>, delete the branch, read both back; throws unless confirmed. */
function archiveAndDropBranch(repo: string, id: string, branch: string): string {
  const tip = git(repo, ["rev-parse", `refs/heads/${branch}`]);
  const archive = archiveRefAt(repo, tip) ?? (git(repo, ["update-ref", `refs/pai-archive/${id}`, tip]), `refs/pai-archive/${id}`);
  if (!branchArchived(repo, `refs/heads/${branch}`, [archive])) throw new Error(`archive ${archive} does not keep ${branch}`);
  git(repo, ["branch", "-D", branch]);
  let still = true;
  try {
    git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  } catch {
    still = false;
  }
  if (still) throw new Error(`branch ${branch} still exists in ${repo} after delete`);
  if (git(repo, ["rev-parse", "--verify", archive]) !== tip) throw new Error(`archive ${archive} does not hold ${tip}`);
  return archive;
}

/** `pai worker discard <id>`: drop worktree and branch after salvaging what they carry. */
export function discardWorker(logDir: string, id: string): string {
  const cur = loadStatus(logDir, id);
  if (!cur || !ownedTree(cur)) {
    const msg = discardBranchOnly(logDir, id);
    if (msg) return msg;
  }
  const st = mustHaveBranch(logDir, id);
  removeScratch(id);
  if (isSlotWorktree(st.worktreeDir!)) {
    // The slot stays; its branch is archived and deleted in the repo that holds it.
    // The slot tree survives, so its scratch dir is discarded here explicitly.
    try {
      rmSync(join(st.worktreeDir!, ".pai-scratch"), { recursive: true, force: true });
    } catch {
      // best effort
    }
    const repo = repoHoldingBranch(st);
    if (!repo) throw new Error(`no repo holds branch ${st.branch} (tried ${[st.worktreeDir, st.cwd, process.cwd()].join(", ")}); nothing discarded`);
    try {
      if (git(st.worktreeDir!, ["rev-parse", "--abbrev-ref", "HEAD"]) === st.branch) git(st.worktreeDir!, ["checkout", "-q", "--detach"]);
    } catch {
      // slot gone or unreadable: the branch is not checked out there
    }
    const archive = archiveAndDropBranch(repo, id, st.branch!);
    saveStatus(logDir, { ...st, branch: null, worktreeDir: null, archived: archive });
    invalidatePendingCache(logDir, repo);
    return `discarded worker ${id}: slot worktree kept, branch ${st.branch} deleted in ${repo}, state kept in ${archive}`;
  }
  let archived: { archive?: string } = {};
  if (existsSync(st.worktreeDir!)) {
    archived = archiveWorktree(logDir, id, st.worktreeDir!, st.branch!);
  } else {
    const repo = repoHoldingBranch(st);
    if (!repo) throw new Error(`no repo holds branch ${st.branch} (tried ${[st.cwd, process.cwd()].join(", ")}); nothing discarded`);
    removeWorktree(repo, st.worktreeDir!, true);
    archived = { archive: archiveAndDropBranch(repo, id, st.branch!) };
  }
  const s = {
    ...st,
    branch: null,
    worktreeDir: null,
    worktreeBase: null,
    worktreeSnapshot: null,
    commits: null,
    merged: false,
  };
  saveStatus(logDir, s);
  invalidatePendingCache(logDir, st.cwd);
  return `discarded worker ${id}: worktree removed, branch ${st.branch} deleted${archived.archive ? `, state kept in ${archived.archive}` : ""}`;
}

/**
 * `pai worker discard --worktree <path>`: the discard path for any linked worktree
 * of any repo (resolved from the worktree itself), not just worker trees. Refuses the
 * main working tree and, without `force`, a dirty one; with `force` the dirty state is
 * committed into the archive first. Commits land under refs/pai-archive/<name>, the
 * branch is deleted only once that ref keeps its tip, ignored notes are salvaged.
 */
export function discardWorktree(logDir: string, path: string, force = false): string {
  const dir = realpathOr(path);
  if (!existsSync(dir)) throw new Error(`no such directory: ${path}`);
  let list: string;
  try {
    list = git(dir, ["worktree", "list", "--porcelain"]);
  } catch {
    throw new Error(`${path} is not inside a git repository`);
  }
  const top = realpathOr(git(dir, ["rev-parse", "--show-toplevel"]));
  if (top !== dir) throw new Error(`${path} is not the root of a worktree (root is ${top})`);
  const blocks = list.split("\n\n").map((b) => b.trim()).filter(Boolean);
  const field = (b: string, k: string): string | undefined => b.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1);
  if (realpathOr(field(blocks[0] ?? "", "worktree") ?? "") === dir) {
    throw new Error(`${path} is the main working tree of its repo; only linked worktrees can be discarded`);
  }
  const block = blocks.find((b) => realpathOr(field(b, "worktree") ?? "") === dir);
  if (!block) throw new Error(`${path} is not a linked worktree`);
  const dirty = uncommittedPaths(dir);
  if (dirty.length && !force) {
    throw new Error(`${path} has ${dirty.length} uncommitted file(s) (${dirty.slice(0, 5).join(", ")}); commit them or pass --force to archive them first`);
  }
  const branch = field(block, "branch")?.replace(/^refs\/heads\//, "") ?? "";
  const repo = commonDir(dir)!;
  const sanitize = (v: string): string => v.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  let id = sanitize(branch) || `detached-${sanitize(basename(dir)) || "tree"}-${(field(block, "HEAD") ?? "").slice(0, 7)}`;
  // never overwrite an earlier archive that holds something else
  const head = git(dir, ["rev-parse", "HEAD"]);
  for (let n = 2; ; n++) {
    let cur: string | null = null;
    try {
      cur = git(repo, ["rev-parse", "--verify", "-q", `refs/pai-archive/${id}`]);
    } catch {
      // free
    }
    if (!cur || cur === head) break;
    id = `${sanitize(branch) || id}-${n}`;
  }
  const res = archiveWorktree(logDir, id, dir, branch);
  appendLedger(ledgerPath(logDir), "WORKER-GC", { id, archive: res.archive, why: "discard-worktree" });
  return `discarded worktree ${dir}: removed${branch ? `, branch ${branch} deleted` : ""}, state kept in ${res.archive} (${repo})`;
}

function mustHaveBranch(logDir: string, id: string): WorkerStatus & Required<Pick<WorkerStatus, "branch" | "worktreeDir">> {
  const st = loadStatus(logDir, id);
  if (!st) throw new Error(`no worker named "${id}"`);
  if (st.resumedBy) throw new Error(`worker ${id} is superseded by ${st.resumedBy}, use that id`);
  if (!ownedTree(st)) {
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
export function worktreeSystemPrompt(id: string, branch: string, dir: string, snapshot = false): string {
  return [
    "You are running in your own git worktree:",
    `  ${dir} on branch ${branch} (worker id ${id}).`,
    "Commit your work on that branch as you go (git add / git commit) — committing here is expected;",
    "the no-commit rule applies to the main branch only, and this is not it.",
    "Do not merge, rebase or push; the operator merges your branch back with `pai worker merge`.",
    "Use ONLY relative paths inside the worktree, never absolute worktree paths — absolute paths break after merge and leak machine layout.",
    ...(snapshot
      ? [
          "This worktree was branched from a snapshot that includes files the parent checkout had uncommitted at spawn time — not just its last commit.",
        ]
      : []),
  ].join("\n");
}

/**
 * For headless runs WITHOUT a worktree: the worker shares the operator's
 * checkout with other in-flight workers, so a hook blocks git stash (except
 * list/show), reset, clean, checkout/restore of paths, switch, rebase and
 * merge — take baselines from measurements before editing, not from stash.
 */
export function inPlaceSystemPrompt(): string {
  return [
    "You are running in the operator's shared git checkout, alongside other workers editing it at the same time.",
    "A hook blocks git stash (except list/show), reset, clean, checkout/restore of files, switch, rebase and merge — take baselines from measurements taken before you edit, not from stashing.",
    "Read-only git (status, diff, log, show, stash list) is fine.",
  ].join("\n");
}

/** Does one of the refs (missing ones are ignored) keep `branchRef`'s tip reachable? */
function branchArchived(repo: string, branchRef: string, refs: string[]): boolean {
  return refs.some((r) => {
    try {
      git(repo, ["rev-parse", "--verify", "-q", r]);
      return isAncestor(repo, branchRef, r);
    } catch {
      return false;
    }
  });
}

/** Branch prefixes PAI creates; gc and discard may clean up branches under them. */
const OWNED_PREFIXES = ["worker/", "spare/"];

function commonDir(dir: string): string | null {
  try {
    const raw = git(dir, ["rev-parse", "--git-common-dir"]);
    return isAbsolute(raw) ? raw : resolve(dir, raw);
  } catch {
    return null;
  }
}

/** Branches checked out in some worktree of the repo (`repo` must be a checkout, not the bare .git dir). */
function checkedOutBranches(repo: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const l of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (l.startsWith("branch refs/heads/")) out.add(l.slice("branch refs/heads/".length));
    }
  } catch {
    // repo unreadable
  }
  return out;
}

/** Existing refs/pai-archive/* ref whose commit is `sha`, if any. */
function archiveRefAt(repo: string, sha: string): string | null {
  try {
    for (const l of git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/pai-archive/"]).split("\n")) {
      const [obj, ref] = l.split(" ");
      if (obj === sha && ref) return ref;
    }
  } catch {
    // none
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/**
 * Archive (when its tip is not yet preserved) and delete one branch that has no
 * worktree. Returns the archive ref, or the reason it was kept. `dryRun` only reports.
 */
function archiveOrphanBranch(repo: string, branch: string, dryRun: boolean): { archive: string } | { kept: string } {
  const ref = `refs/heads/${branch}`;
  let tip: string;
  try {
    tip = git(repo, ["rev-parse", "--verify", "-q", ref]);
  } catch {
    return { kept: "branch is gone" };
  }
  let archive = archiveRefAt(repo, tip);
  if (!archive) {
    let inMain = false;
    try {
      inMain = isAncestor(repo, ref, mainRef(repo));
    } catch {
      // no comparable main
    }
    if (!inMain) return { kept: "kept: unarchived commits" };
    archive = `refs/pai-archive/branch-${branch.replace(/\//g, "-")}`;
    if (!dryRun) git(repo, ["update-ref", archive, tip]);
  }
  if (!dryRun) {
    if (!branchArchived(repo, ref, [archive])) return { kept: "archive does not keep the branch tip" };
    git(repo, ["branch", "-D", branch]);
  }
  return { archive };
}

/** gc: archive and delete branches under worker/ and spare/ that no worktree has checked out. */
function gcOrphanBranches(logDir: string, repos: Iterable<string>, protect: Set<string>, dryRun: boolean, out: GcEntry[]): void {
  const pool = readPoolState(logDir);
  const hostUp = !!pool && pidAlive(pool.hostPid);
  const spares = new Set((pool?.spares ?? []).map((sp) => sp.branch));
  const seen = new Set<string>();
  for (const r of repos) {
    const repo = commonDir(r);
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    const live = checkedOutBranches(r);
    const repoName = basename(basename(repo) === ".git" ? dirname(repo) : repo);
    let names: string[];
    try {
      names = git(repo, ["for-each-ref", "--format=%(refname:short)", ...OWNED_PREFIXES.map((x) => `refs/heads/${x}`)]).split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const branch of names) {
      if (live.has(branch) || protect.has(branch) || (hostUp && spares.has(branch))) continue;
      try {
        const res = archiveOrphanBranch(repo, branch, dryRun);
        if ("kept" in res) out.push({ id: branch, branch: true, repoName, skipped: res.kept });
        else out.push({ id: branch, branch: true, repoName, archive: res.archive });
      } catch (e) {
        out.push({ id: branch, branch: true, repoName, skipped: (e as Error).message.split("\n")[0] });
      }
    }
  }
}

/** discard with only a branch left (status gone or already archived): archive if needed, delete it. */
function discardBranchOnly(logDir: string, id: string): string | null {
  const st = loadStatus(logDir, id);
  if (st?.resumedBy) throw new Error(`worker ${id} is superseded by ${st.resumedBy}, use that id`);
  for (const repoDir of new Set([st?.cwd, process.cwd()].filter((d): d is string => !!d))) {
    const repo = commonDir(repoDir);
    if (!repo) continue;
    for (const prefix of OWNED_PREFIXES) {
      const branch = `${prefix}${id}`;
      try {
        git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
      } catch {
        continue;
      }
      if (checkedOutBranches(repoDir).has(branch)) throw new Error(`branch ${branch} is checked out in a worktree`);
      const target = `refs/pai-archive/${id}`;
      const tip = git(repo, ["rev-parse", `refs/heads/${branch}`]);
      const archive = archiveRefAt(repo, tip) ?? (git(repo, ["update-ref", target, tip]), target);
      if (!branchArchived(repo, `refs/heads/${branch}`, [archive])) throw new Error(`archive ${archive} does not keep ${branch}`);
      git(repo, ["branch", "-D", branch]);
      if (st) saveStatus(logDir, { ...st, branch: null, worktreeDir: null, archived: archive });
      invalidatePendingCache(logDir, repo);
      return `discarded worker ${id}: only branch ${branch} was left, deleted, state kept in ${archive}`;
    }
  }
  return null;
}

export interface GcEntry {
  id: string;
  /** archive ref, or the reason the worktree was skipped. */
  archive?: string;
  /** an orphan branch (no worktree): id is the branch name */
  branch?: boolean;
  /** repo (directory name) an orphan branch lives in */
  repoName?: string;
  skipped?: string;
  knowledge?: Knowledge;
  /** one line per file copied into the main checkout */
  salvaged?: string[];
  /** sha of a detached HEAD fast-forwarded onto the branch before archiving */
  adopted?: string;
}

export interface ArchiveResult {
  archive: string;
  knowledge: Knowledge;
  salvaged: string[];
}

/**
 * The one removal path (gc, discard): check what the worktree carries, archive
 * commits and uncommitted state under refs/pai-archive/<id>, copy ignored
 * knowledge files into the main checkout, then remove worktree and branch.
 * Throws, with the worktree untouched, when anything cannot be salvaged.
 */
export function archiveWorktree(logDir: string, id: string, dir: string, branch: string): ArchiveResult {
  const target = `refs/pai-archive/${id}`;
  // The shared object store and refs live in the main repo; the recorded cwd
  // may be another worker's worktree that gc already removed.
  let repo: string;
  try {
    const raw = git(dir, ["rev-parse", "--git-common-dir"]);
    repo = isAbsolute(raw) ? raw : resolve(dir, raw);
  } catch {
    throw new Error("not a git worktree");
  }
  const checkout = basename(repo) === ".git" ? dirname(repo) : repo;
  const knowledge = worktreeKnowledge(logDir, id, dir);
  const label = `archive: leftover state of worker ${id}`;
  // Detach HEAD before anything here writes a commit: a worktree may hold a
  // shared branch (a worker ran `git checkout -B feature/...` in it), and a
  // salvage commit made while that branch is checked out would move it — the
  // worktree's stale index would then revert real work on the shared branch
  // (live on 2026-10-27, archive c3aef37fb on feature/824-obsidian-integration).
  // `--detach` keeps index and working tree, so every salvage/amend commit lands
  // on a detached HEAD kept only by the archive ref.
  let otherBranch: string | null = null;
  let otherRefBefore: string | null = null;
  let headRef: string | null = null;
  try {
    headRef = git(dir, ["symbolic-ref", "-q", "HEAD"]);
  } catch {
    // already detached: no branch is checked out here, nothing to guard, no detach needed
  }
  if (headRef) {
    if (headRef !== `refs/heads/${branch}`) {
      otherBranch = headRef.replace(/^refs\/heads\//, "");
      try {
        otherRefBefore = git(repo, ["rev-parse", "--verify", "-q", headRef]);
      } catch {
        // not a branch ref (e.g. refs/foo/HEAD): nothing to guard
        otherBranch = null;
      }
    }
    // A branch IS checked out here: the detach must succeed before anything commits.
    // Outside any catch — a failed switch throws now, the worktree stays untouched.
    git(dir, ["checkout", "-q", "--detach"]);
  }
  if (uncommittedPaths(dir).length) {
    // salvageUncommitted labels "salvaged: <label>"; keep the requested subject
    const res = salvageUncommitted(dir, label);
    if (res.committed.length) git(dir, ["commit", "--amend", "-q", "-m", label]);
    if (res.skipped.length && uncommittedPaths(dir).some((p) => existsSync(join(dir, p)) && !symlinkEscapesWorktree(dir, p))) {
      throw new Error("uncommitted paths remain");
    }
  }
  let hasBranch = true;
  try {
    git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  } catch {
    hasBranch = false;
  }
  const tip = git(dir, ["rev-parse", "HEAD"]);
  // never drop a branch whose tip the archive ref would not keep reachable
  if (hasBranch && !isAncestor(repo, `refs/heads/${branch}`, tip)) {
    // worktree HEAD moved off the branch: keep the branch tip under its own ref
    git(repo, ["update-ref", `${target}-branch`, `refs/heads/${branch}`]);
  }
  const salvage = salvageIgnored(checkout, dir, id);
  if (salvage.failed.length) throw new Error(`cannot salvage ${salvage.failed.join(", ")}`);
  git(repo, ["update-ref", target, tip]);
  const notes = [...salvage.lines];
  if (knowledge.commits.length || knowledge.dirty.length) {
    notes.push(`archived ${knowledge.commits.length} commit(s), ${knowledge.dirty.length} uncommitted file(s) of worker ${id} in ${target}`);
  }
  for (const m of knowledge.missing) notes.push(`written but missing: ${m} (worker ${id}; see its transcript)`);
  for (const l of notes) console.log(l);
  if (hasBranch && !branchArchived(repo, `refs/heads/${branch}`, [target, `${target}-branch`])) {
    throw new Error(`archive ${target} does not keep ${branch}`);
  }
  // a branch other than the worker's own that was checked out here must end
  // exactly where it was — the detach above kept it, and nothing may have
  // moved it (live 2026-10-27: a salvage commit reverted 186 lines on a
  // shared feature branch checked out in this worktree)
  if (otherBranch && otherRefBefore) {
    const after = git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${otherBranch}`]);
    if (after !== otherRefBefore) {
      throw new Error(
        `archive of ${dir} moved branch ${otherBranch} (${otherRefBefore.slice(0, 7)} -> ${after.slice(0, 7)}); ` +
          `nothing was committed to it by this archive; the worktree was kept`
      );
    }
  }
  git(repo, ["worktree", "remove", "--force", dir]);
  if (hasBranch) git(repo, ["branch", "-D", branch]);
  removeScratch(id);
  return { archive: target, knowledge, salvaged: salvage.lines };
}

/**
 * A worker that finished with nothing to merge (no commits, no uncommitted or
 * missing files) has no use for its worktree: archive the empty state and
 * remove it now. Anything else is left for merge/discard/gc. Never throws.
 */
export function archiveEmptyResult(logDir: string, st: WorkerStatus): boolean {
  const tree = ownedTree(st);
  if (!tree || !existsSync(tree.dir) || isSlotWorktree(tree.dir) || isLive(st)) return false;
  try {
    const k = worktreeKnowledge(logDir, st.id, tree.dir);
    if (k.commits.length || k.dirty.length || k.missing.length) return false;
    if (safeCommitsSince(tree.dir, st.worktreeBase ?? "HEAD") > 0) return false;
    const target = `refs/pai-archive/${st.id}`;
    archiveWorktree(logDir, st.id, tree.dir, tree.branch);
    saveStatus(logDir, { ...st, branch: null, worktreeDir: null, commits: null, archived: target });
    appendLedger(ledgerPath(logDir), "WORKER-GC", { id: st.id, archive: target, why: "empty" });
    invalidatePendingCache(logDir, st.cwd);
    return true;
  } catch {
    return false; // kept for gc, which reports it
  }
}

/** Bytes under `dir` (du -sk), 0 when unreadable. */
function dirBytes(dir: string): number {
  const r = spawnSync("du", ["-sk", dir], { encoding: "utf8" });
  return (parseInt(String(r.stdout).split("\t")[0] ?? "", 10) || 0) * 1024;
}

/** Worktree count and total size, for `pai worker ps` and the cockpit. */
export function worktreesStats(logDir: string): { count: number; bytes: number } {
  const root = worktreesDir(logDir);
  if (!existsSync(root)) return { count: 0, bytes: 0 };
  const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  return { count: dirs.length, bytes: dirs.length ? dirBytes(root) : 0 };
}

const statsCache = new Map<string, { at: number; stats: { count: number; bytes: number }; refreshing: boolean }>();

/** Bytes under `dir` (du -sk) without blocking the event loop, 0 when unreadable. */
function dirBytesAsync(dir: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("du", ["-sk", dir], { encoding: "utf8" }, (_e, stdout) => resolve((parseInt(String(stdout).split("\t")[0] ?? "", 10) || 0) * 1024));
  });
}

/**
 * Worktree count and size for the cockpit, which polls every few seconds on the router's event
 * loop. The count is a cheap readdir; the size is a `du` over every worktree (seconds), so it is
 * refreshed in the background at most once a minute and the last reading is served meanwhile.
 * `bytes` is -1 until the first `du` has finished.
 */
export function worktreesStatsCached(logDir: string, now = Date.now()): { count: number; bytes: number } {
  const root = worktreesDir(logDir);
  const hit = statsCache.get(logDir);
  const count = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
  if (count === 0) return { count: 0, bytes: 0 };
  if (!hit || (now - hit.at >= 60_000 && !hit.refreshing)) {
    const entry = hit ?? { at: now, stats: { count, bytes: -1 }, refreshing: false };
    entry.refreshing = true;
    statsCache.set(logDir, entry);
    void dirBytesAsync(root).then((bytes) => {
      entry.stats = { count, bytes };
      entry.at = Date.now();
      entry.refreshing = false;
    });
  }
  const cur = statsCache.get(logDir)!;
  return { count, bytes: cur.stats.bytes };
}

export function formatWorktreesStats(s: { count: number; bytes: number }): string {
  return s.bytes < 0 ? `worktrees: ${s.count}` : `worktrees: ${s.count} (${(s.bytes / 1024 ** 3).toFixed(1)} GB)`;
}

/** Finished workers whose worktree is still on disk (not merged, not discarded, not archived). */
export function leftoverWorktrees(logDir: string): number {
  let n = 0;
  for (const st of loadStatuses(logDir)) {
    const tree = ownedTree(st);
    if (tree && existsSync(tree.dir) && !isLive(st) && !isSlotWorktree(tree.dir)) n++;
  }
  return n;
}

/**
 * True only for a directory that is itself a git worktree: its toplevel is the directory
 * and its repository lists it. A leftover without .git (say, only node_modules) resolves
 * git to an enclosing repository, which must never be status'ed, stashed or archived.
 */
export function isRealWorktree(dir: string): boolean {
  try {
    const real = realpathSync(dir);
    if (realpathSync(git(dir, ["rev-parse", "--show-toplevel"])) !== real) return false;
    return git(dir, ["worktree", "list", "--porcelain"])
      .split("\n")
      .some((l) => l.startsWith("worktree ") && realpathOr(l.slice(9)) === real);
  } catch {
    return false;
  }
}

const GC_STAMP = "gc-last";

/**
 * Pid of a live process whose cwd is `dir` or below (shell drivers parked in a
 * worker tree), else 0. One `lsof -d cwd` listing, no tree walk. If lsof is
 * missing or fails, nothing is reported busy.
 */
export function busyPid(dir: string): number {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    return 0;
  }
  let raw = "";
  try {
    raw = execFileSync("lsof", ["-d", "cwd", "-Fpn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch (e) {
    // lsof exits 1 when some entries are unreadable but still prints the rest
    raw = String((e as { stdout?: string }).stdout ?? "");
  }
  let pid = 0;
  for (const line of raw.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid !== process.pid) {
      const name = line.slice(1);
      if (name === real || name.startsWith(real + sep)) return pid;
    }
  }
  return 0;
}

export const KEEP_FILE = ".pai-keep";

/** First line of `<dir>/.pai-keep` (the reason; "kept" when empty), or null when the file is absent. */
export function keepMarker(dir: string): string | null {
  try {
    return readFileSync(join(dir, KEEP_FILE), "utf8").split("\n")[0]!.trim() || "kept";
  } catch {
    return null;
  }
}

/** `pai worker keep`: write (reason) or remove (null) the `.pai-keep` marker of a worktree given by worker id or path. Returns the directory. */
export function setKeep(logDir: string, target: string, reason: string | null): string {
  let dir = target;
  if (!target.includes("/")) {
    const st = loadStatuses(logDir).find((x) => x.id === target);
    dir = (st && ownedTree(st)?.dir) || worktreePath(logDir, target);
  }
  dir = resolve(dir);
  if (!existsSync(dir)) throw new Error(`no worktree at ${dir}`);
  if (reason === null) rmSync(join(dir, KEEP_FILE), { force: true });
  else writeFileSync(join(dir, KEEP_FILE), `${reason.replace(/\n+/g, " ")}\n`, "utf8");
  return dir;
}

/**
 * Why gc must leave `dir` alone: a `.pai-keep` marker, or a running process with its cwd inside.
 * The one check every gc path calls; logs WORKER-GC-KEEP unless `dryRun`.
 */
export function gcKeepReason(logDir: string, id: string, dir: string, dryRun: boolean): string | null {
  let reason: string | null = null;
  const marker = keepMarker(dir);
  if (marker !== null) reason = `kept: .pai-keep: ${marker}`;
  else {
    const pid = busyPid(dir);
    if (pid) reason = `busy: pid ${pid} has its cwd inside`;
  }
  if (reason && !dryRun) appendLedger(ledgerPath(logDir), "WORKER-GC-KEEP", { id, reason });
  return reason;
}

/** gc for a finished slot worker: archive the branch tip under refs/pai-archive/<id>, delete the branch. */
function archiveSlotBranch(
  logDir: string,
  st: WorkerStatus,
  tree: { dir: string; branch: string },
  dryRun: boolean,
  report: boolean,
  out: GcEntry[]
): void {
  const id = st.id;
  const target = `refs/pai-archive/${id}`;
  let repo: string;
  try {
    const raw = git(st.cwd, ["rev-parse", "--git-common-dir"]);
    repo = isAbsolute(raw) ? raw : resolve(st.cwd, raw);
    git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${tree.branch}`]);
  } catch {
    return; // branch already gone or repo unreadable: nothing to archive
  }
  let onBranch = false;
  try {
    onBranch = existsSync(tree.dir) && git(tree.dir, ["symbolic-ref", "-q", "HEAD"]) === `refs/heads/${tree.branch}`;
  } catch {
    // detached
  }
  if (onBranch) return void out.push({ id, skipped: `slot worktree is still on ${tree.branch}` });
  const adopted = dryRun ? null : adoptDetachedHead(tree.dir, tree.branch);
  const knowledge = (): Knowledge => {
    const k: Knowledge = { commits: [], dirty: [], ignored: [], missing: [] };
    try {
      k.commits = git(repo, ["cherry", mainRef(repo), `refs/heads/${tree.branch}`])
        .split("\n")
        .filter((l) => l.startsWith("+ "))
        .map((l) => l.slice(2));
    } catch {
      // no comparable base
    }
    return k;
  };
  const entry = (extra: Partial<GcEntry> = {}): GcEntry => ({
    id,
    archive: target,
    ...(report ? { knowledge: knowledge() } : {}),
    ...(adopted ? { adopted } : {}),
    ...extra,
  });
  if (dryRun) return void out.push(entry());
  try {
    const k = knowledge();
    git(repo, ["update-ref", target, `refs/heads/${tree.branch}`]);
    git(repo, ["branch", "-D", tree.branch]);
    if (k.commits.length) console.log(`archived ${k.commits.length} commit(s) of worker ${id} in ${target}`);
    saveStatus(logDir, { ...st, branch: null, worktreeDir: null, archived: target });
    appendLedger(ledgerPath(logDir), "WORKER-GC", { id, archive: target });
    out.push(entry());
  } catch (e) {
    out.push({ id, skipped: (e as Error).message.split("\n")[0] });
  }
}

/**
 * `gc --foreign`: worktrees of `repo` that PAI did not create (not main, not under the
 * logDir's worktrees/slots, not owned by a worker status), whose branch is fully merged
 * into main, go through the same `archive` path as worker trees under
 * refs/pai-archive/<branch>. Unmerged ones are reported as kept. A detached-HEAD tree whose
 * commit is in main goes the same way under refs/pai-archive/detached-<dir>-<sha7>, with its
 * uncommitted state committed into the archive. PAI's own slot trees are skipped above:
 * they live in a directory named `slots` (isSlotWorktree) or under the logDir.
 */
function gcForeign(
  logDir: string,
  repo: string,
  owned: Set<string>,
  dryRun: boolean,
  report: boolean,
  out: GcEntry[],
  archive: (id: string, dir: string, branch: string, st: WorkerStatus | null) => void
): void {
  let raw: string;
  let main: string;
  try {
    raw = git(repo, ["worktree", "list", "--porcelain"]);
    main = mainRef(repo);
  } catch {
    return; // not a repo
  }
  const pai = resolve(logDir);
  const blocks = raw.split("\n\n").map((b) => b.trim()).filter(Boolean);
  blocks.slice(1).forEach((block) => {
    const field = (k: string): string | undefined => block.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1);
    const dir = field("worktree");
    if (!dir || !existsSync(dir) || block.includes("\nprunable")) return;
    const real = resolve(dir);
    if (owned.has(real) || real === pai || real.startsWith(pai + sep) || isSlotWorktree(real)) return;
    const ref = field("branch");
    const branch = ref?.replace(/^refs\/heads\//, "");
    const sanitize = (v: string): string => v.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    if (!branch) {
      // detached HEAD: eligible when its commit is in main; the archive ref keeps commit + uncommitted state
      const head = field("HEAD") ?? "";
      const id = `detached-${sanitize(basename(real)) || "tree"}-${head.slice(0, 7)}`;
      if (!head || !isAncestor(repo, head, main)) return void out.push({ id, skipped: "kept: not merged" });
      return archive(id, real, `detached/${id}`, null);
    }
    if (!isAncestor(repo, `refs/heads/${branch}`, main)) return void out.push({ id: branch, skipped: "kept: not merged" });
    const safe = sanitize(branch) || "branch";
    archive(safe, real, branch, null);
  });
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Worktrees a finished worker made by hand inside its scratch dir (<systmp>/pai-scratch/<id>/…):
 * no status owns them and their branch can be named anything, so they are found through the
 * repo's worktree list by path. Same archive path as any other tree (uncommitted state
 * salvaged, branch deleted after archiving); a live worker's trees are never touched.
 */
function gcScratchTrees(
  statuses: WorkerStatus[],
  owned: Set<string>,
  extraRepos: (string | undefined)[],
  out: GcEntry[],
  archive: (id: string, dir: string, branch: string, st: WorkerStatus | null) => void
): void {
  const finished = new Map(statuses.filter((st) => !isLive(st)).map((st) => [st.id, st]));
  const done = new Set<string>();
  const seenRepo = new Set<string>();
  // a worker's own cwd may be another repo than the one it built a tree in: look in every repo gc knows
  for (const cwd of [...statuses.map((st) => st.cwd), ...extraRepos]) {
    if (!cwd || !existsSync(cwd)) continue;
    let raw: string;
    try {
      raw = git(cwd, ["worktree", "list", "--porcelain"]);
    } catch {
      continue;
    }
    const first = raw.split("\n\n")[0] ?? "";
    if (seenRepo.has(first)) continue;
    seenRepo.add(first);
    for (const block of raw.split("\n\n").map((b) => b.trim()).filter(Boolean).slice(1)) {
      const field = (k: string): string | undefined => block.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1);
      const dir = field("worktree");
      if (!dir || !existsSync(dir) || block.includes("\nprunable")) continue;
      const real = realpathOr(dir);
      const wid = /^.*\/pai-scratch\/([^/]+)\/(.+)/.exec(real);
      const st = wid && finished.get(wid[1]!);
      if (!st || done.has(real) || owned.has(real)) continue;
      done.add(real);
      const branch = field("branch")?.replace(/^refs\/heads\//, "");
      const id = `${st.id}-${basename(real).replace(/[^A-Za-z0-9._-]+/g, "-") || "tree"}`;
      if (!branch) {
        out.push({ id, skipped: "kept: detached HEAD in scratch tree" });
        continue;
      }
      archive(id, real, branch, null);
    }
  }
}

/** True when every commit main..`tip` is on main by hash or by patch-id (`git cherry` prints no "+"). */
function landedOnMain(repo: string, tip: string): boolean {
  const main = mainRef(repo);
  if (isAncestor(repo, tip, main)) return true;
  return !git(repo, ["cherry", main, tip]).split("\n").some((l) => l.startsWith("+ "));
}

/**
 * Worktrees under the logDir whose work is already on main, whatever their age: the worker is
 * not running, the tree is clean, and the HEAD (and branch tip) commits are on main by hash or
 * by patch (a cherry-pick has a new hash). Worktrees whose branch was deleted or renamed are
 * judged by their HEAD. Anything else is kept; `report` (the CLI) lists it with the reason. Returns the reclaimed dirs.
 */
function gcLandedTrees(
  logDir: string,
  statuses: WorkerStatus[],
  repos: (string | undefined)[],
  out: GcEntry[],
  report: boolean,
  archive: (id: string, dir: string, branch: string, st: WorkerStatus | null) => void
): Set<string> {
  const keep = (id: string, skipped: string): void => {
    if (report) out.push({ id, skipped });
  };
  const reclaimed = new Set<string>();
  const root = realpathOr(worktreesDir(logDir));
  const byDir = new Map<string, WorkerStatus>();
  for (const st of statuses) {
    const t = ownedTree(st);
    if (t) byDir.set(realpathOr(t.dir), st);
  }
  const seenRepo = new Set<string>();
  for (const cwd of repos) {
    if (!cwd || !existsSync(cwd)) continue;
    let raw: string;
    try {
      raw = git(cwd, ["worktree", "list", "--porcelain"]);
    } catch {
      continue;
    }
    const blocks = raw.split("\n\n").map((b) => b.trim()).filter(Boolean);
    const mainDir = (blocks[0] ?? "").split("\n")[0]?.slice("worktree ".length);
    if (!mainDir || seenRepo.has(mainDir)) continue;
    seenRepo.add(mainDir);
    for (const block of blocks.slice(1)) {
      const field = (k: string): string | undefined => block.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1);
      const dir = field("worktree");
      if (!dir || !existsSync(dir) || block.includes("\nprunable")) continue;
      const real = realpathOr(dir);
      if (!real.startsWith(root + sep) || isSlotWorktree(real) || basename(real).startsWith("spare-")) continue;
      const st = byDir.get(real) ?? null;
      const id = st?.id ?? basename(real);
      if (st && isLive(st)) {
        keep(id, "worker is running");
        continue;
      }
      const branch = field("branch")?.replace(/^refs\/heads\//, "");
      try {
        if (git(real, ["status", "--porcelain"])) {
          keep(id, "kept: uncommitted changes");
          continue;
        }
        const tips = [git(real, ["rev-parse", "HEAD"])];
        if (branch) tips.push(git(mainDir, ["rev-parse", `refs/heads/${branch}`]));
        if (!tips.every((t) => landedOnMain(mainDir, t))) {
          keep(id, "kept: commits not on main");
          continue;
        }
      } catch (e) {
        keep(id, `kept: ${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      const before = out.length;
      archive(id, real, branch ?? `detached/${id}`, st);
      if (out[before]?.archive) reclaimed.add(real);
    }
  }
  return reclaimed;
}

/**
 * Archive worktrees of finished workers older than `olderThanHours` and
 * status-less orphan directories: uncommitted state is salvaged onto the
 * branch, the branch is x, the worktree is
 * removed. Nothing is deleted without a salvage first; a failed salvage skips
 * that worktree. Running workers are never touched. `dryRun` reports only.
 */
export function gcWorktrees(
  logDir: string,
  olderThanHours = 24,
  dryRun = false,
  now = Date.now(),
  report = false,
  maxGb?: number,
  foreignRepo?: string
): GcEntry[] {
  const cutoff = now - olderThanHours * 3_600_000;
  const out: GcEntry[] = [];
  const root = worktreesDir(logDir);
  const statuses = loadStatuses(logDir);
  const owned = new Set(statuses.map((s) => ownedTree(s)?.dir).filter((d): d is string => !!d).map((d) => resolve(d)));
  const archive = (id: string, dir: string, branch: string, st: WorkerStatus | null): void => {
    const target = `refs/pai-archive/${id}`;
    if (!isRealWorktree(dir)) return void out.push({ id, skipped: "not a worktree" });
    const why = gcKeepReason(logDir, id, dir, dryRun);
    if (why) return void out.push({ id, skipped: why });
    if (dryRun) return void out.push(report ? { id, archive: target, knowledge: worktreeKnowledge(logDir, id, dir) } : { id, archive: target });
    try {
      const adopted = adoptDetachedHead(dir, branch);
      const res = archiveWorktree(logDir, id, dir, branch);
      if (st) saveStatus(logDir, { ...st, branch: null, worktreeDir: null, archived: target });
      appendLedger(ledgerPath(logDir), "WORKER-GC", { id, archive: target });
      out.push({ id, archive: target, ...(res.salvaged.length ? { salvaged: res.salvaged } : {}), ...(adopted ? { adopted } : {}) });
    } catch (e) {
      out.push({ id, skipped: (e as Error).message.split("\n")[0] });
    }
  };

  // Landed work goes first, at any age; in a dry run the trees stay on disk, so they are skipped below.
  const landed = gcLandedTrees(logDir, statuses, [...new Set([...statuses.map((s) => s.cwd), foreignRepo, process.cwd()])], out, report, archive);
  const mark = out.length;

  const young: { st: WorkerStatus; tree: { dir: string; branch: string }; end: number }[] = [];
  for (const st of statuses) {
    const tree = ownedTree(st);
    if (!tree || !existsSync(tree.dir) || isLive(st) || isSlotWorktree(tree.dir) || landed.has(realpathOr(tree.dir))) continue;
    let end = 0;
    try {
      // whole ms like Date.now(): a sub-ms-newer mtime must not read as "after now"
      end = Math.floor(statSync(statusPath(logDir, st.id)).mtimeMs);
    } catch {
      continue;
    }
    if (end > cutoff) {
      young.push({ st, tree, end });
      continue;
    }
    archive(st.id, tree.dir, tree.branch, st);
  }

  // Size guard: over the cap, archive the oldest remaining finished trees too.
  // Running workers are not in `young`; a tree that cannot be salvaged is reported, not removed.
  if (maxGb && existsSync(root) && !dryRun) {
    const cap = maxGb * 1024 ** 3;
    let total = dirBytes(root);
    if (total > cap) {
      console.log(`worktree gc: ${(total / 1024 ** 3).toFixed(1)} GB over cap ${maxGb} GB, archiving oldest finished`);
      for (const y of young.sort((a, b) => a.end - b.end)) {
        if (total <= cap) break;
        const size = dirBytes(y.tree.dir);
        const before = out.length;
        archive(y.st.id, y.tree.dir, y.tree.branch, y.st);
        const e = out[before];
        if (e?.archive) {
          total -= size;
          console.log(`worktree gc: cap archived ${y.st.id} (${(size / 1024 ** 3).toFixed(2)} GB)`);
        } else if (e?.skipped) {
          console.log(`worktree gc: cap kept ${y.st.id}: ${e.skipped}`);
        }
      }
      if (total > cap) console.log(`worktree gc: still ${(total / 1024 ** 3).toFixed(1)} GB over cap ${maxGb} GB (running or unsalvageable workers)`);
    }
  }

  // Pooled-slot workers: a branch in the shared slot worktree, never a tree of their own.
  for (const st of statuses) {
    const tree = ownedTree(st);
    if (!tree || st.merged || st.archived || isLive(st) || !isSlotWorktree(tree.dir)) continue;
    let end = 0;
    try {
      end = Math.floor(statSync(statusPath(logDir, st.id)).mtimeMs);
    } catch {
      continue;
    }
    if (end > cutoff) continue;
    archiveSlotBranch(logDir, st, tree, dryRun, report, out);
  }

  if (existsSync(root)) {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      const dir = join(root, ent.name);
      // owned by a status (the last id of a resume chain) is that status's business
      if (!ent.isDirectory() || owned.has(resolve(dir)) || isSlotWorktree(dir) || ent.name.startsWith("spare-") || landed.has(realpathOr(dir))) continue;
      try {
        if (Math.floor(statSync(dir).mtimeMs) > cutoff) continue;
      } catch {
        continue;
      }
      archive(ent.name, dir, worktreeBranch(ent.name), null);
    }
  }
  gcScratchTrees(statuses, owned, [foreignRepo, process.cwd()], out, archive);
  if (foreignRepo) gcForeign(logDir, foreignRepo, owned, dryRun, report, out, archive);
  // Orphan branches: no worktree, tip in main or already archived. Never a live worker's branch.
  const protect = new Set(statuses.filter((s) => isLive(s) && s.branch).map((s) => s.branch!));
  const repos = new Set(statuses.map((s) => s.cwd).filter((c) => existsSync(c)));
  if (foreignRepo) repos.add(foreignRepo);
  gcOrphanBranches(logDir, repos, protect, dryRun, out);
  // a tree kept by the landed check that the age rule then archived is not "kept"
  const archivedIds = new Set(out.slice(mark).filter((e) => e.archive).map((e) => e.id));
  for (let i = mark - 1; i >= 0; i--) if (out[i]!.skipped?.startsWith("kept:") && archivedIds.has(out[i]!.id)) out.splice(i, 1);
  if (!dryRun) {
    for (const repo of new Set(statuses.map((s) => s.cwd))) {
      try {
        git(repo, ["worktree", "prune"]);
      } catch {
        // repo gone
      }
      invalidatePendingCache(logDir, repo);
    }
  }
  return out;
}

/** True when `cmd` is a pool host process (the bundled worker-pool-host or the pool-host module). */
export function isPoolHostCmd(cmd: string): boolean {
  return /(^|[/\s])(worker-pool-host\.mjs|pool-host\.(m?js|ts))(\s|$)/.test(cmd);
}

/** True when `pid` is alive and its command is a pool host (a reused pid is not). */
function isLivePoolHost(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return isPoolHostCmd(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return false;
  }
}

/** Pid of the pool host recorded in the state file, 0 when none. */
function poolHostPidOf(logDir: string): number {
  const st = readPoolState(logDir);
  return st?.hostPid && st.hostPid > 0 ? st.hostPid : 0;
}

/**
 * Spare trees the pool state lists as a spare or a claimed slot of a host that is
 * still alive: the host may claim or serve one right now, so gc must not touch it.
 * The host pid is checked against its command (`ps`), not only its existence — a
 * pid reused by an unrelated process is a dead host, and its spares stay leftovers.
 */
function livePoolSpareDirs(logDir: string): Set<string> {
  const st = readPoolState(logDir);
  if (!st) return new Set();
  const hostPid = st.hostPid && st.hostPid > 0 ? st.hostPid : 0;
  if (!hostPid) return new Set();
  if (!isLivePoolHost(hostPid)) return new Set(); // host gone, or its pid reused by something else
  const out = new Set<string>();
  for (const s of st.spares ?? []) if (s.dir) out.add(resolve(s.dir));
  for (const slot of st.slots) if (slot.busyWith) out.add(resolve(slot.cwd));
  return out;
}

/**
 * gc --pool: the pool keeps no reserve worktrees, so every spare-* tree under
 * worktrees/ and every slots/* tree that no worker status owns and no process
 * sits in is a leftover. Same removal path as discard: commits archived under
 * refs/pai-archive/<id>, gitignored notes salvaged, then tree and branch go.
 * A spare the pool state lists under a live pool host is not a leftover: its
 * claude may sit in the worktree with an empty cwd (lsof sees nothing) and a
 * run may claim it at any moment.
 */
export function gcPoolWorktrees(logDir: string, dryRun = false): GcEntry[] {
  const out: GcEntry[] = [];
  // A finished worker's status keeps naming its slot, so only a live owner protects a slot tree.
  const owned = new Set(
    loadStatuses(logDir)
      .filter((s) => isLive(s) || !isSlotWorktree(s.worktreeDir ?? ""))
      .map((s) => ownedTree(s)?.dir)
      .filter((d): d is string => !!d)
      .map((d) => resolve(d))
  );
  const poolHostPid = poolHostPidOf(logDir);
  const poolSpares = livePoolSpareDirs(logDir);
  // a state file that exists but does not parse (torn write) says nothing: protect by busyPid as before
  const stateUnknown = existsSync(poolStatePath(logDir)) && !readPoolState(logDir);
  const cands: { id: string; dir: string }[] = [];
  const list = (root: string, keep: (n: string) => boolean, idOf: (n: string) => string): void => {
    if (!existsSync(root)) return;
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory() && keep(ent.name)) cands.push({ id: idOf(ent.name), dir: join(root, ent.name) });
    }
  };
  list(worktreesDir(logDir), (n) => n.startsWith("spare-"), (n) => n);
  list(join(logDir, "slots"), () => true, (n) => `slot-${n}`);
  for (const { id, dir } of cands) {
    if (owned.has(resolve(dir))) continue;
    if (poolSpares.has(resolve(dir))) {
      out.push({ id, skipped: `pool spare of live host pid ${poolHostPid}` });
      continue;
    }
    // spare-<pid>-N of a live pool host is never an orphan, listed in the state or not (it may be
    // between addSpareWorktree and the first persist)
    const hostOfSpare = /^spare-(\d+)-\d+$/.exec(id);
    if (hostOfSpare && isLivePoolHost(Number(hostOfSpare[1]))) {
      out.push({ id, skipped: `spare of live pool host pid ${hostOfSpare[1]}` });
      continue;
    }
    if (!isRealWorktree(dir)) {
      out.push({ id, skipped: "not a worktree" });
      continue;
    }
    // A spare-* tree named by no live pool state is an orphan even when a process sits in it:
    // a host that died without cleanup leaves its spare's claude parked in the tree.
    const marked = keepMarker(dir);
    if (marked !== null) {
      const why = gcKeepReason(logDir, id, dir, dryRun);
      out.push({ id, skipped: why! });
      continue;
    }
    if (!id.startsWith("spare-") || stateUnknown) {
      const why = gcKeepReason(logDir, id, dir, dryRun);
      if (why) {
        out.push({ id, skipped: why });
        continue;
      }
    }
    let branch = "";
    try {
      branch = git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
    } catch {
      // detached HEAD
    }
    const target = `refs/pai-archive/${id}`;
    if (dryRun) {
      out.push({ id, archive: target, knowledge: worktreeKnowledge(logDir, id, dir) });
      continue;
    }
    try {
      const res = archiveWorktree(logDir, id, dir, branch);
      appendLedger(ledgerPath(logDir), "WORKER-GC", { id, archive: target });
      out.push({ id, archive: target, ...(res.salvaged.length ? { salvaged: res.salvaged } : {}) });
    } catch (e) {
      out.push({ id, skipped: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/** Run `gcWorktrees` at most once per `everyMin` minutes (stamp file in the logDir). */
export function gcWorktreesThrottled(
  logDir: string,
  everyMin = 60,
  now = Date.now(),
  opts: { olderThanHours?: number; maxGb?: number } = {}
): GcEntry[] | null {
  const stamp = join(logDir, GC_STAMP);
  try {
    if (now - statSync(stamp).mtimeMs < everyMin * 60_000) return null;
  } catch {
    // never ran
  }
  mkdirSync(logDir, { recursive: true });
  writeFileSync(stamp, String(now), "utf8");
  return gcWorktrees(logDir, opts.olderThanHours ?? 24, false, now, false, opts.maxGb);
}
