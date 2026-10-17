/**
 * Which conversations were started by `pai worker run` (not by a person).
 * Worker runs record their Claude conversation id in `<id>.status` and work in
 * a git worktree under the worker log directory; either marks a session as a
 * worker's, so `pai ls` and the picker can hide them by default.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";

export interface WorkerSessionFilter {
  isWorker(s: { uuid: string; decodedPath: string }): boolean;
}

export function workerLogDirOrNull(): string | null {
  try {
    return workersLogDir(readWorkersSection().workers);
  } catch {
    return null;
  }
}

/** Conversation ids recorded by worker runs in `logDir`. Never throws. */
export function readWorkerSessionIds(logDir: string | null): Set<string> {
  const ids = new Set<string>();
  if (!logDir) return ids;
  let files: string[];
  try {
    files = readdirSync(logDir).filter((f) => f.endsWith(".status"));
  } catch {
    return ids;
  }
  for (const f of files) {
    try {
      const rec = JSON.parse(readFileSync(join(logDir, f), "utf8")) as { claudeSession?: string };
      if (rec.claudeSession) ids.add(rec.claudeSession);
    } catch {
      /* unreadable status file: not a worker marker */
    }
  }
  return ids;
}

export function workerSessionFilter(logDir: string | null = workerLogDirOrNull()): WorkerSessionFilter {
  const ids = readWorkerSessionIds(logDir);
  const marker = "/workers/worktrees/";
  return {
    isWorker: (s) => ids.has(s.uuid) || s.decodedPath.includes(marker),
  };
}
