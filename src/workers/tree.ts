/**
 * tree.ts — sub-workers: parent detection and the tree caps.
 *
 * A worker launched by another worker (the runner exports PAI_WORKER_ID in
 * every worker's environment) carries `parent` in its status, so the worker
 * forest is visible in `ps`, the status line and the ledger. Two caps keep
 * the tree from growing without bound, both under `workers.tree`:
 *
 *   - maxDepth (default 2): how deep sub-workers may nest. A top-level worker
 *     sits at depth 0; its children at 1; grandchildren at 2 — one level past
 *     the cap refuses with a clear message.
 *   - maxChildren (default 4): how many children of one parent may run at the
 *     same time. Finished children do not count; a planner works through its
 *     sub-tasks in waves of this size.
 *
 * Chain stages also carry `parent` (the chain id), but chains are not workers
 * and never get a status file — a parent without a status is not capped.
 */

import type { WorkersTreeConfig } from "./config.js";
import { isLive, loadStatus, loadStatuses, saveStatus, type WorkerStatus } from "./status.js";

/** The env var the runner sets in every worker's environment. */
export const WORKER_ID_ENV = "PAI_WORKER_ID";

/** The worker this process runs inside, when it runs inside one. */
export function parentFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env[WORKER_ID_ENV];
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Depth of `id` in the worker forest: 0 for a top-level worker, 1 + the
 * parent's depth for a sub-worker. Parents without a status file (chain ids,
 * unknown ids) count as roots; a cycle reads as its own depth and is cut off
 * after the statuses it walked. `chatIsRoot` stops one level short of the
 * chat-pane tracker (origin "chat"): the status line treats the pane as the
 * bar itself, so the workers it spawned are its top level.
 */
export function workerDepth(
  statuses: WorkerStatus[],
  id: string,
  opts?: { chatIsRoot?: boolean }
): number {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  let depth = 0;
  let cur = byId.get(id);
  const seen = new Set<string>([id]);
  while (cur?.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    const next = byId.get(cur.parent);
    if (!next) break; // chain id or stale parent: a root, not a level
    if (!(opts?.chatIsRoot && next.origin === "chat")) depth += 1;
    cur = next;
  }
  return depth;
}

/** Children of `parent` that are still running, oldest first. */
export function runningChildren(statuses: WorkerStatus[], parent: string): WorkerStatus[] {
  return statuses.filter((s) => s.parent === parent && isLive(s));
}

/**
 * Would starting a child of `parent` stay within the caps? Throws with a
 * clear message when it would not; returns silently when `parent` has no
 * status file (a chain id or an unknown id — not a worker, not capped).
 */
export function assertChildAllowed(
  logDir: string,
  parent: string,
  caps: WorkersTreeConfig,
  statuses: WorkerStatus[] = loadStatuses(logDir)
): void {
  if (!statuses.some((s) => s.id === parent)) return;
  const depth = workerDepth(statuses, parent);
  if (depth + 1 > caps.maxDepth) {
    throw new Error(
      `worker tree: ${parent} sits at depth ${depth} and ` +
        `workers.tree.maxDepth is ${caps.maxDepth} — it cannot start another level of sub-workers. ` +
        `Hand the task up instead: pai worker handoff '{"kind":"proposal","text":"…"}'`
    );
  }
  const kids = runningChildren(statuses, parent);
  if (kids.length >= caps.maxChildren) {
    throw new Error(
      `worker tree: ${parent} already has ${kids.length} running sub-workers ` +
        `(${kids.map((k) => k.id).join(", ")}) and workers.tree.maxChildren is ${caps.maxChildren} — ` +
        `wait for one to finish, or raise the cap in the workers config`
    );
  }
}

/**
 * The parent a launch should record: an explicit one (chain stage) wins, else
 * the worker this process runs inside. Returns null for top-level runs.
 */
export function launchParent(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  return explicit ?? parentFromEnv(env);
}

/** Does a status file exist for `id` (i.e. is it a worker rather than a chain)? */
export function isWorkerId(logDir: string, id: string): boolean {
  return loadStatus(logDir, id) !== null;
}

/**
 * A worker owns its children's results (the worker contract says so): if
 * `parent` exits leaving sub-workers unaccounted for, its own run must not
 * report success. Two shapes count, both read off `runningChildren` and the
 * raw statuses, never a second live-child lookup:
 *
 *   - still live: left running untouched (killing another process's work
 *     here would be its own bug) but named in the reason.
 *   - marked "running" with a dead pid (the child never got to write its own
 *     terminal state before its parent vanished from under it): finalised
 *     here as failed, so `ps` stops showing a corpse as live.
 *
 * Returns the reason string for the parent's own report, or null when every
 * child it started is accounted for.
 */
export function checkOrphanedChildren(logDir: string, parent: string): string | null {
  const statuses = loadStatuses(logDir);
  const live = runningChildren(statuses, parent);
  const abandoned = statuses.filter(
    (s) => s.parent === parent && s.state === "running" && !isLive(s)
  );
  for (const child of abandoned) {
    saveStatus(logDir, { ...child, state: "failed", last: `parent ${parent} exited` });
  }
  const ids = [...live, ...abandoned].map((s) => s.id);
  if (!ids.length) return null;
  return (
    `exited with ${ids.length} sub-worker${ids.length === 1 ? "" : "s"} still running ` +
    `(${ids.join(", ")}); they were not waited for — run children in the foreground or wait for them before finishing`
  );
}
