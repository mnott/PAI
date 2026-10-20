/**
 * registry-scan trigger policy.
 *
 * Every session Stop and PreCompact hook asks the daemon for a registry scan,
 * headless workers included, and a scan walks thousands of project dirs
 * (tens of seconds of CPU). Unbounded, a busy worker fleet kept the daemon
 * scanning back to back. So: at most one scan queued or running, repeat
 * triggers inside REGISTRY_SCAN_COALESCE_MS collapse into it, and triggers
 * from paths that can never be registered (worker worktrees, temp dirs,
 * linked worktrees) are dropped.
 */

import { enqueueCoalesced, type WorkItem } from "./work-queue.js";
import { unregistrableReason } from "../registry/registrable.js";

/** Triggers closer together than this share one scan; the 30 min timer is the backstop. */
export const REGISTRY_SCAN_COALESCE_MS = 10 * 60 * 1000;

/** Why a trigger from `cwd` cannot change the registry, or undefined if it can. */
export function registryScanIgnoredReason(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || !cwd) return undefined;
  return unregistrableReason(cwd);
}

/** Enqueue a registry-scan unless filtered or coalesced. Returns the item, or null. */
export function triggerRegistryScan(cwd?: unknown, now = Date.now()): WorkItem | null {
  const ignored = registryScanIgnoredReason(cwd);
  if (ignored) {
    process.stderr.write(`[work-queue] registry-scan trigger ignored (${String(cwd)}: ${ignored}).\n`);
    return null;
  }
  return enqueueCoalesced({ type: "registry-scan", priority: 5, payload: {} }, REGISTRY_SCAN_COALESCE_MS, now);
}
