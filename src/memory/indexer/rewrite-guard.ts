/**
 * A mass rewrite is never silent: an index pass that rewrites more than a set
 * share of all chunks (a registry rebuilt under new project ids, a chunker bump,
 * a changed root) says so in the daemon log and on the cockpit index tile.
 * Unchanged files are skipped by hash, so a healthy pass rewrites a few percent.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { paiHomeDir } from "../../config/pai-home.js";
import { loadConfig } from "../../daemon/config.js";

export const DEFAULT_REWRITE_WARN_PERCENT = 20;
/** Below this many chunks a first index of a small install is not worth a warning. */
const MIN_CHUNKS_TO_WARN = 1000;

export interface RewriteWarning {
  at: number;
  rewritten: number;
  total: number;
  percent: number;
  message: string;
}

/** The warning for a pass that rewrote `rewritten` of `total` chunks, null when within `maxPercent`. */
export function rewriteWarning(rewritten: number, total: number, maxPercent: number = DEFAULT_REWRITE_WARN_PERCENT, now: number = Date.now()): RewriteWarning | null {
  if (total < MIN_CHUNKS_TO_WARN || rewritten <= 0) return null;
  const percent = (100 * rewritten) / total;
  if (percent <= maxPercent) return null;
  const message =
    `index pass rewrote ${rewritten} of ${total} chunks (${percent.toFixed(0)}%, limit ${maxPercent}%): ` +
    `files looked changed (new project ids, chunker version or root path?); vectors are carried over by text hash where known`;
  return { at: now, rewritten, total, percent, message };
}

function warningPath(home: string): string {
  return `${home}/run-progress/index-warning.json`;
}

/** Record the pass's warning for the cockpit; a pass within the limit clears the previous one. */
export function recordRewriteWarning(w: RewriteWarning | null, home: string = paiHomeDir()): void {
  try {
    if (!w) {
      unlinkSync(warningPath(home));
      return;
    }
    mkdirSync(`${home}/run-progress`, { recursive: true });
    const tmp = `${warningPath(home)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(w) + "\n", "utf8");
    renameSync(tmp, warningPath(home));
  } catch {
    /* nothing to clear, or a read-only home: the log line below still stands */
  }
}

export function readRewriteWarning(home: string): RewriteWarning | null {
  try {
    return JSON.parse(readFileSync(warningPath(home), "utf8")) as RewriteWarning;
  } catch {
    return null;
  }
}

/** Check a finished pass, log loudly and record for the cockpit; returns the warning. */
export function guardMassRewrite(rewritten: number, total: number, maxPercent?: number): RewriteWarning | null {
  let limit = maxPercent;
  if (limit === undefined) {
    try { limit = loadConfig().indexRewriteWarnPercent; } catch { /* default */ }
  }
  const w = rewriteWarning(rewritten, total, limit);
  if (w) process.stderr.write(`[pai-daemon] WARNING ${w.message}\n`);
  recordRewriteWarning(w);
  return w;
}
