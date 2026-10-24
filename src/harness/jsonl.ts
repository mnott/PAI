/** Reading shared by the harness adapters: session ordering and JSONL replay. */

import { readFileSync } from "node:fs";
import type { HarnessSession } from "./types.js";

/** Sort/filter time of an updatedAt stamp; an unparsable one counts as 0 (oldest). */
function sortMs(updatedAt: string): number {
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Sessions updated within `sinceMs` (all when undefined), newest first. */
export function newestFirst(sessions: HarnessSession[], sinceMs?: number): HarnessSession[] {
  const since = sinceMs !== undefined ? Date.now() - sinceMs : undefined;
  return sessions
    .filter((s) => since === undefined || sortMs(s.updatedAt) >= since)
    .sort((a, b) => sortMs(b.updatedAt) - sortMs(a.updatedAt));
}

/** The parsed JSON lines of a file in order; an unreadable file yields none, unparsable lines are skipped. */
export function* jsonlRecords<T>(path: string): Iterable<T> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      yield JSON.parse(raw) as T;
    } catch {
      continue;
    }
  }
}
