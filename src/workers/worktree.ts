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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir, platform } from "node:os";
import { isLive, loadStatus, loadStatuses, saveStatus, UNLABELED, type WorkerStatus } from "./status.js";
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

/** Run git in `cwd` with an optional env override, trimmed stdout, stderr on failure. */
function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 30_000): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
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
}

/**
 * Commit `cwd`'s current index + working tree (including untracked files) as
 * a floating commit on top of HEAD, without touching the real index, working
 * tree or HEAD: a temporary `GIT_INDEX_FILE` collects the snapshot, `git
 * commit-tree` writes the commit object directly (it updates no ref). The
 * caller then branches a worktree from that commit, so the worktree sees
 * exactly what was on disk, uncommitted or not.
 */
function snapshotUncommitted(cwd: string, id: string, head: string): string {
  const idxDir = mkdtempSync(join(tmpdir(), "pai-worktree-idx-"));
  const idx = join(idxDir, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    runGit(cwd, ["read-tree", head], env);
    runGit(cwd, ["add", "-A"], env);
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
 * refuses (no commits yet, branch exists, …) — the caller decides whether to
 * degrade to an in-place run.
 */
export function addWorktree(logDir: string, id: string, cwd: string): WorktreeInfo {
  const dir = worktreePath(logDir, id);
  const branch = worktreeBranch(id);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const dirty = dirtyPaths(cwd).length > 0;
  const base = dirty ? snapshotUncommitted(cwd, id, head) : head;
  git(cwd, ["worktree", "add", dir, "-b", branch, base]);
  provisionDeps(logDir, id, cwd, dir);
  return { dir, branch, base, snapshot: dirty };
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
      // an unignored node_modules would be committed by salvage
      git(wtDir, ["check-ignore", "-q", "node_modules"]);
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
  st: WorkerStatus & Required<Pick<WorkerStatus, "branch" | "worktreeDir">>
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
        `Commit it yourself, or drop everything with: pai worker discard ${id}`
    );
  }
  const changedPaths = git(st.cwd, ["diff", "--name-only", snapshot, branch]).split("\n").filter(Boolean);
  assertNoSnapshotDrift(st.cwd, snapshot, changedPaths, id);
  const diff = execFileSync("git", ["-C", st.cwd, "diff", "--binary", snapshot, branch], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (diff.trim()) {
    try {
      execFileSync("git", ["-C", st.cwd, "apply", "--binary"], {
        input: diff,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
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
  return notes.length ? `${base}; ${notes.join("; ")}` : base;
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
  if (st.worktreeSnapshot) return mergeSnapshotWorker(logDir, id, st);
  // salvage first: only a commit can carry uncommitted work through the merge
  const salvage = existsSync(st.worktreeDir!)
    ? salvageUncommitted(st.worktreeDir!, st.label || UNLABELED)
    : { committed: [], skipped: [] };
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
  // force: assertWorktreeClean already confirmed nothing but a skipped
  // outside-pointing symlink (if anything) remains uncommitted
  removeWorktree(st.cwd, st.worktreeDir!, true);
  let branchGone = true;
  try {
    git(st.cwd, ["branch", "-d", st.branch!]);
  } catch {
    branchGone = false; // -d refuses anything not fully merged; keep the branch, say so
  }
  const s = { ...st, merged: true };
  saveStatus(logDir, s);
  const base = `merged ${st.branch} into ${st.cwd} (worktree removed${branchGone ? ", branch deleted" : "; branch kept: git refused -d"})`;
  const notes: string[] = [];
  if (salvage.committed.length) {
    notes.push(`salvaged ${salvage.committed.length} uncommitted change(s): ${salvage.committed.join(", ")}`);
  }
  if (salvage.skipped.length) {
    notes.push(`skipped ${salvage.skipped.join(", ")}`);
  }
  return notes.length ? `${base}; ${notes.join("; ")}` : base;
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

export interface GcEntry {
  id: string;
  /** archive ref, or the reason the worktree was skipped. */
  archive?: string;
  skipped?: string;
}

const GC_STAMP = "gc-last";

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
  now = Date.now()
): GcEntry[] {
  const cutoff = now - olderThanHours * 3_600_000;
  const out: GcEntry[] = [];
  const root = worktreesDir(logDir);
  const known = new Set<string>();
  const archive = (id: string, dir: string, st: WorkerStatus | null): void => {
    const target = `refs/pai-archive/${id}`;
    if (dryRun) return void out.push({ id, archive: target });
    try {
      // The shared object store and refs live in the main repo; the recorded cwd
      // may be another worker's worktree that gc already removed.
      let repo: string;
      try {
        const raw = git(dir, ["rev-parse", "--git-common-dir"]);
        repo = isAbsolute(raw) ? raw : resolve(dir, raw);
      } catch {
        throw new Error("not a git worktree");
      }
      const label = `archive: leftover state of worker ${id}`;
      if (uncommittedPaths(dir).length) {
        // salvageUncommitted labels "salvaged: <label>"; keep the requested subject
        const res = salvageUncommitted(dir, label);
        if (res.committed.length) git(dir, ["commit", "--amend", "-q", "-m", label]);
        if (res.skipped.length && uncommittedPaths(dir).some((p) => !symlinkEscapesWorktree(dir, p))) {
          throw new Error("uncommitted paths remain");
        }
      }
      const src = worktreeBranch(id);
      let hasBranch = true;
      try {
        git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${src}`]);
      } catch {
        hasBranch = false;
      }
      const tip = git(dir, ["rev-parse", "HEAD"]);
      // never drop a branch whose tip the archive ref would not keep reachable
      if (hasBranch) git(repo, ["merge-base", "--is-ancestor", `refs/heads/${src}`, tip]);
      git(repo, ["update-ref", target, tip]);
      git(repo, ["worktree", "remove", "--force", dir]);
      if (hasBranch) git(repo, ["branch", "-D", src]);
      if (st) saveStatus(logDir, { ...st, branch: null, worktreeDir: null, archived: target });
      appendLedger(ledgerPath(logDir), "WORKER-GC", { id, archive: target });
      out.push({ id, archive: target });
    } catch (e) {
      out.push({ id, skipped: (e as Error).message.split("\n")[0] });
    }
  };

  for (const st of loadStatuses(logDir)) {
    known.add(st.id);
    if (!st.worktreeDir || !existsSync(st.worktreeDir) || isLive(st)) continue;
    let end = 0;
    try {
      end = statSync(statusPath(logDir, st.id)).mtimeMs;
    } catch {
      continue;
    }
    if (end > cutoff) continue;
    archive(st.id, st.worktreeDir, st);
  }

  if (existsSync(root)) {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || known.has(ent.name) || existsSync(statusPath(logDir, ent.name))) continue;
      const dir = join(root, ent.name);
      try {
        if (statSync(dir).mtimeMs > cutoff) continue;
      } catch {
        continue;
      }
      archive(ent.name, dir, null);
    }
  }
  if (!dryRun) {
    for (const repo of new Set(loadStatuses(logDir).map((s) => s.cwd))) {
      try {
        git(repo, ["worktree", "prune"]);
      } catch {
        // repo gone
      }
    }
  }
  return out;
}

/** Run `gcWorktrees` at most once per `everyMin` minutes (stamp file in the logDir). */
export function gcWorktreesThrottled(logDir: string, everyMin = 60, now = Date.now()): GcEntry[] | null {
  const stamp = join(logDir, GC_STAMP);
  try {
    if (now - statSync(stamp).mtimeMs < everyMin * 60_000) return null;
  } catch {
    // never ran
  }
  mkdirSync(logDir, { recursive: true });
  writeFileSync(stamp, String(now), "utf8");
  return gcWorktrees(logDir, 24, false, now);
}
