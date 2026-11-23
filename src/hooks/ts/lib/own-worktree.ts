import { realpathSync } from "node:fs";
import { currentWorkerId } from "../../../workers/worker-id.js";
import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { loadStatus } from "../../../workers/status.js";

/**
 * The worker's own worktree dir (its status file's worktreeDir) when cwd lies inside it, else null. The
 * worktree root is a fact about the worker, not about cwd: a fixture repo nested in the worktree (cd'ed into)
 * has its own git toplevel, but is still inside the worktree.
 */
export function ownWorktreeDir(cwd: string, env: NodeJS.ProcessEnv, logDirOverride?: string): string | null {
  try {
    const logDir = logDirOverride || env.PAI_WORKER_LOOP_DIR || workersLogDir(readWorkersSection().workers);
    const id = currentWorkerId(env, logDir);
    const dir = id ? loadStatus(logDir, id)?.worktreeDir : null;
    if (!dir) return null;
    const real = (p: string): string => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const rd = real(dir);
    const rc = real(cwd);
    return rc === rd || rc.startsWith(rd.endsWith("/") ? rd : `${rd}/`) ? dir : null;
  } catch {
    return null;
  }
}
