/**
 * Which conversations were started by `pai worker run` (not by a person).
 * Worker runs record their Claude conversation id in `<id>.status` and work in
 * a git worktree under the worker log directory; either marks a session as a
 * worker's, so every session list, the picker and name lookup (scanSessions) hide them by default.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";

export interface WorkerSessionFilter {
  isWorker(s: { uuid: string; decodedPath?: string; encodedDir?: string; clcDirectory?: string }): boolean;
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

/** Claude Code's project-dir encoding of a path: every non-alphanumeric becomes "-". */
function encodeCwd(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * A session is a worker's when its conversation id is in a status file
 * (--no-worktree workers) or its cwd is under `<logDir>/worktrees`. The cwd is
 * matched on the encoded project dir, because decoding it back to a path is
 * ambiguous for names with dashes, dots or spaces.
 */
export function workerSessionFilter(logDir: string | null = workerLogDirOrNull()): WorkerSessionFilter {
  const ids = readWorkerSessionIds(logDir);
  const worktrees = logDir ? join(logDir, "worktrees") : null;
  const prefix = worktrees ? encodeCwd(worktrees) + "-" : null;
  return {
    isWorker: (s) =>
      ids.has(s.uuid) ||
      (!!worktrees &&
        !!prefix &&
        ((!!s.encodedDir && s.encodedDir.startsWith(prefix)) ||
          [s.decodedPath, s.clcDirectory].some((p) => !!p && p.startsWith(worktrees + "/")) ||
          (!!s.clcDirectory && encodeCwd(s.clcDirectory).startsWith(prefix)))),
  };
}
