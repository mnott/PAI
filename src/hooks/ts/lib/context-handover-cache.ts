/**
 * context-handover-cache.ts — the well-known file where the threshold-
 * triggered pre-compaction handover (see ../../../daemon/context-handover-
 * worker.ts) is written, and where context-compression-hook.ts looks for it
 * at compaction time.
 *
 * Deliberately dependency-light (fs/os/path only). The daemon worker that
 * WRITES this file needs the heavier machinery in session-summary-worker.ts
 * (spawning Claude, git log, etc.), but the PreCompact hook that READS it
 * runs as a short-lived process on every compaction and must not drag in
 * daemon state, database pools, or anything else that module graph carries —
 * this file is the shared seam so neither side has to.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type HandoverThreshold = "warmup" | "refresh";

export interface ContextHandoverCache {
  sessionId: string;
  cwd: string;
  threshold: HandoverThreshold;
  generatedAt: string; // ISO timestamp
  model: string;
  summary: string;
}

export function contextHandoverCachePath(sessionId: string): string {
  return join(tmpdir(), `pai-context-handover-${sessionId}.json`);
}

export function readContextHandoverCache(sessionId: string): ContextHandoverCache | null {
  const path = contextHandoverCachePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ContextHandoverCache;
  } catch {
    return null;
  }
}

export function writeContextHandoverCache(cache: ContextHandoverCache): void {
  writeFileSync(contextHandoverCachePath(cache.sessionId), JSON.stringify(cache, null, 2), "utf-8");
}

/** A handover older than this is not "current" even when generated after the
 *  previous compaction: a session fills its window over hours, and a cache
 *  written at the start of that fill misses everything since. */
export const HANDOVER_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface HandoverVerdict {
  /** Inject as current. false = inject labelled stale, or not at all (cache null). */
  fresh: boolean;
  label: string;
}

function formatAge(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 120 ? `${min}min` : `${Math.round(min / 60)}h`;
}

/**
 * Judge a cached handover at compaction time. Fresh = generated after the
 * previous compaction AND within HANDOVER_MAX_AGE_MS. Anything else is
 * labelled stale with its age; no cache says so (generation failed or never ran).
 */
export function judgeHandover(
  cache: ContextHandoverCache | null,
  previousCompactionAt: string | null,
  now: number
): HandoverVerdict {
  if (!cache) {
    return { fresh: false, label: "mechanical scrape only (no model-written handover exists: generation failed or never ran)" };
  }
  const generated = Date.parse(cache.generatedAt);
  const age = formatAge(now - generated);
  const detail = `${cache.model}, generated ${cache.generatedAt}, age ${age}, threshold=${cache.threshold}`;
  const prev = previousCompactionAt ? Date.parse(previousCompactionAt) : NaN;
  if (!(generated > prev) && !Number.isNaN(prev)) {
    return { fresh: false, label: `STALE model-written handover (${detail}) — predates the previous compaction; generation for this one failed` };
  }
  if (now - generated > HANDOVER_MAX_AGE_MS) {
    return { fresh: false, label: `STALE model-written handover (${detail}) — older than ${formatAge(HANDOVER_MAX_AGE_MS)}, misses recent work; refresh did not complete` };
  }
  return { fresh: true, label: `model-written handover (${detail}) + mechanical scrape` };
}
