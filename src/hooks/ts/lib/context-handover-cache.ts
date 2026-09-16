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
