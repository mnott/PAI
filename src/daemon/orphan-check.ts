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
const STARTUP_DELAY_MS = 60_000;

export interface OrphanWarning {
  orphaned: number;
  total: number;
  message: string;
}

/** The warning for these counts, or null when they are within the 1 % tolerance. */
export function orphanWarning(c: OrphanCounts): OrphanWarning | null {
  if (c.total <= 0 || c.orphaned / c.total <= ORPHAN_WARN_FRACTION) return null;
  return { ...c, message: `orphaned chunks: ${c.orphaned} — run \`pai memory repair-orphans\`` };
}

let current: OrphanWarning | null = null;

/** What the cockpit shows: the last check's warning, null when clean or not yet checked. */
export function currentOrphanWarning(): OrphanWarning | null {
  return current;
}

export async function checkOrphans(
  count: () => Promise<OrphanCounts>,
  log: (line: string) => void = (l) => void process.stderr.write(l),
): Promise<OrphanWarning | null> {
  try {
    current = orphanWarning(await count());
    if (current) log(`[pai-daemon] WARNING ${current.message} (${current.orphaned} of ${current.total} chunks have no project)\n`);
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
