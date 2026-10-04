/**
 * registrable.ts — directories that must never become registered projects.
 *
 * A project is a durable thing. The registry, however, has been accepting
 * whatever directory a session happened to start in, and some of those
 * directories are disposable by construction. Measured on the real registry,
 * 2026-08-04:
 *
 *   08 - Others/MDF/Infrastruktur/.claude/worktrees/cool-haibt      1 session
 *   08 - Others/MDF/Infrastruktur/.claude/worktrees/strange-haibt   7 sessions
 *   /private/tmp/ops-webui                                          dead
 *   /private/tmp/claude-501/-Users-…-AIBroker/aae854c6-…            dead
 *
 * The worktrees are agent isolation directories, created to be removed. The temp
 * paths are exactly what their name says. Registering them attributes session
 * history to a location with no future, and lets `pai <name>` route someone into
 * a directory a cleanup can delete underneath them.
 *
 * So this refuses at the point of registration rather than reclassifying
 * afterwards. It is a guard, not a policy about what health should call things —
 * it stops the set growing while the vocabulary question (dead vs duplicate vs
 * misnamed vs ephemeral) is decided separately.
 *
 * Found by the AIBroker session while we were dividing up the dead-path work.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { worktreesDir } from "../workers/worktree.js";
import type { RegistryBackend } from "../storage/registry-interface.js";

/**
 * The `gitdir:` target of a linked worktree, or undefined. A linked worktree's
 * `.git` is a FILE ("gitdir: <main>/.git/worktrees/<name>"); a normal repo's is
 * a directory and a submodule's points under `.git/modules/`.
 */
function linkedWorktreeGitdir(root: string): string | undefined {
  const dotGit = resolve(root, ".git");
  try {
    if (!statSync(dotGit).isFile()) return undefined;
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
    return m && m[1].includes(`${sep}worktrees${sep}`) ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** True when `root` is a linked git worktree (its `.git` is a `gitdir:` file). */
export function isLinkedWorktree(root: string): boolean {
  return linkedWorktreeGitdir(root) !== undefined;
}

/** The main repo a linked worktree belongs to, when resolvable. */
export function mainRepoOf(root: string): string | undefined {
  const gitdir = linkedWorktreeGitdir(root);
  // <main>/.git/worktrees/<name> -> <main>
  return gitdir ? dirname(dirname(dirname(gitdir))) : undefined;
}

/** The worker worktrees root from the workers config; undefined if unreadable. */
function workerWorktreesRoot(): string | undefined {
  try {
    return resolve(worktreesDir(workersLogDir(readWorkersSection().workers)));
  } catch {
    return undefined;
  }
}

/** Path fragments that mark a location as disposable, with why. */
const EPHEMERAL: ReadonlyArray<{ fragment: string; because: string }> = [
  {
    // Agent worktrees. `.claude/worktrees/<name>` is created for isolation during
    // one task and removed afterwards.
    fragment: `${sep}.claude${sep}worktrees${sep}`,
    because: "a git worktree created for agent isolation — it is meant to be removed",
  },
  {
    // Worker log dirs and their worktrees, current (`<pai home>/logs/workers`)
    // and legacy (`~/.claude/logs/workers`) layouts, including the dir itself.
    fragment: `${sep}logs${sep}workers${sep}`,
    because: "a worker log directory or worktree — it is meant to be removed",
  },
  {
    fragment: `${sep}private${sep}tmp${sep}`,
    because: "a system temp directory",
  },
  {
    fragment: `${sep}var${sep}folders${sep}`,
    because: "a macOS per-user temp directory",
  },
];

/** Why a path is a (linked or worker) git worktree, or undefined. */
export function worktreeReason(
  rootPath: string,
  worktreesRoot: string | undefined = workerWorktreesRoot()
): string | undefined {
  if (isLinkedWorktree(rootPath)) {
    const main = mainRepoOf(rootPath);
    return `a linked git worktree${main ? ` of ${main}` : ""}`;
  }
  const abs = resolve(rootPath);
  if (worktreesRoot && (abs === worktreesRoot || abs.startsWith(worktreesRoot + sep))) {
    return "a worker worktree";
  }
  return undefined;
}

/**
 * Why this path cannot be a project, or undefined if it can.
 *
 * Returns the reason rather than a boolean so the caller can tell the user which
 * rule caught them — "refused" without a reason invites someone to work around it
 * rather than move their project somewhere durable.
 */
export function unregistrableReason(
  rootPath: string,
  worktreesRoot: string | undefined = workerWorktreesRoot()
): string | undefined {
  const wt = worktreeReason(rootPath, worktreesRoot);
  if (wt) return wt;

  // Compare with trailing separators so a fragment cannot match a partial
  // directory name: `/tmp/` must not match `/tmpdir/`.
  const padded = rootPath.endsWith(sep) ? rootPath : rootPath + sep;

  for (const { fragment, because } of EPHEMERAL) {
    if (padded.includes(fragment)) return because;
  }

  // A bare `/tmp/...` too. Kept separate from the list above because on macOS
  // /tmp is a symlink to /private/tmp, so both spellings reach the same place and
  // only one of them contains "private".
  if (padded.startsWith(`${sep}tmp${sep}`)) return "a system temp directory";

  return undefined;
}

/**
 * Remove registry rows whose root is unregistrable (linked worktree, worker
 * worktree/log dir, temp dir; rows registered before the guard existed). Returns
 * the slugs removed. Sessions on those rows are worker/agent scratch history.
 */
export async function pruneWorktreeProjects(
  backend: RegistryBackend,
  worktreesRoot: string | undefined = workerWorktreesRoot()
): Promise<string[]> {
  const removed: string[] = [];
  for (const p of await backend.listProjects({})) {
    if (unregistrableReason(p.root_path, worktreesRoot)) {
      await backend.deleteProjectCascade(p.id);
      removed.push(p.slug);
    }
  }
  return removed;
}
