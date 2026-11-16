/**
 * orphan-check.ts — chunks whose project_id is not in `projects`.
 *
 * 2026-10-24 a registry rebuild gave every project a new id and 2.79M chunks
 * stayed under the old ones, unnoticed for hours. Checked at startup and
 * hourly; above 1 % of all chunks it warns in the daemon log and the cockpit
 * memory tile (`orphans`).
 */

import type { OrphanCounts } from "../storage/registry-interface.js";

export const ORPHAN_WARN_FRACTION = 0.01;
export const ORPHAN_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** A warning line goes to the log at most this often, however often we check. */
export const ORPHAN_LOG_MIN_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;

/** What an operator runs to actually act on unmapped orphans. */
export const UNMAPPED_HINT =
  "run `pai memory repair-orphans --delete --execute` (removes copies that a current project already holds; backed up first); `--include-stale` also removes old versions without a twin";

export interface OrphanWarning {
  orphaned: number;
  total: number;
  message: string;
}

/** The warning for these counts, or null when they are within the 1 % tolerance. */
export function orphanWarning(c: OrphanCounts): OrphanWarning | null {
  if (c.total <= 0 || c.orphaned / c.total <= ORPHAN_WARN_FRACTION) return null;
  const base = `orphaned chunks: ${c.orphaned}`;
  // actionable === false: plain repair-orphans changes nothing, name the command that acts
  const message =
    c.actionable === false
      ? `${base} — none map to a current project; ${UNMAPPED_HINT}`
      : `${base} — run \`pai memory repair-orphans\``;
  return { ...c, message };
}

let current: OrphanWarning | null = null;
let lastLoggedAt = -Infinity;

/** What the cockpit shows: the last check's warning, null when clean or not yet checked. */
export function currentOrphanWarning(): OrphanWarning | null {
  return current;
}

export async function checkOrphans(
  count: () => Promise<OrphanCounts>,
  log: (line: string) => void = (l) => void process.stderr.write(l),
): Promise<OrphanWarning | null> {
  try {
    const w = orphanWarning(await count());
    // the cockpit state updates every check; the log line at most once per interval,
    // and again when the warning changes (e.g. plain repair-orphans will not act)
    if (w && (w.message !== current?.message || Date.now() - lastLoggedAt >= ORPHAN_LOG_MIN_INTERVAL_MS)) {
      lastLoggedAt = Date.now();
      log(`[pai-daemon] WARNING ${w.message} (${w.orphaned} of ${w.total} chunks have no project)\n`);
    }
    current = w;
  } catch (e) {
    log(`[pai-daemon] orphan check failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return current;
}

export function startOrphanCheck(count: () => Promise<OrphanCounts>): void {
  const run = (): void => void checkOrphans(count);
  setTimeout(run, STARTUP_DELAY_MS).unref?.();
  setInterval(run, ORPHAN_CHECK_INTERVAL_MS).unref?.();
}
