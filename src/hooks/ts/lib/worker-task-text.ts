/**
 * worker-task-text.ts — a worker's own task text (its brief), for the gates that match it.
 *
 * The L0 delegation gate reads the operator's latest prompt from the transcript; a worker has no
 * operator prompt, its brief is the task text the run kept: the --spec file or the <id>.prompt copy
 * named by its status (see workers/run/gate.ts promptCopy). Resolved from PAI_WORKER_ID /
 * PAI_POOL_SLOT through the log dir (worker-id.ts), same lookup as the loop guard's state files.
 */

import { existsSync, readFileSync } from "node:fs";
import { loadStatus } from "../../../workers/status.js";
import { currentWorkerId } from "../../../workers/worker-id.js";

/** This worker's task text: its status' spec/promptFile copy; undefined when it cannot be resolved or read (callers fail closed). */
export function workerTaskText(env: NodeJS.ProcessEnv, logDir: string): string | undefined {
  try {
    const id = currentWorkerId(env, logDir);
    if (!id) return undefined;
    const st = loadStatus(logDir, id);
    if (!st) return undefined;
    const file = [st.promptFile, st.spec].find((f): f is string => !!f && f !== "-" && existsSync(f));
    if (!file) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
