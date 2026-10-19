/**
 * worker-id.ts — "which job am I", also inside a pooled slot.
 *
 * A pool slot serves many jobs, so it has no static PAI_WORKER_ID. The host
 * gives it a stable PAI_POOL_SLOT=<name> and records the job it hands the slot
 * in <logDir>/slots/<name>.current; this resolver reads that back.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readWorkersSection } from "./config.js";
import { slotCurrentPath, workersLogDir } from "./paths.js";
import { isTerminal, loadStatus } from "./status.js";

export const POOL_SLOT_ENV = "PAI_POOL_SLOT";

/** PAI_WORKER_ID, else the job the pool slot named by PAI_POOL_SLOT serves, else undefined. */
export function currentWorkerId(env: NodeJS.ProcessEnv = process.env, logDir?: string): string | undefined {
  if (env.PAI_WORKER_ID) return env.PAI_WORKER_ID;
  const slot = env[POOL_SLOT_ENV];
  if (!slot) return undefined;
  try {
    const dir = logDir ?? workersLogDir(readWorkersSection().workers);
    const path = slotCurrentPath(dir, slot);
    if (!existsSync(path)) return undefined;
    const id = readFileSync(path, "utf8").trim();
    if (!id) return undefined;
    // a file left by a crashed host points at a job that is over (or never existed)
    const st = loadStatus(dir, id);
    return !st || isTerminal(st.state) ? undefined : id;
  } catch {
    return undefined;
  }
}

export function setSlotCurrent(logDir: string, slot: string, id: string): void {
  const path = slotCurrentPath(logDir, slot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, id + "\n", "utf8");
}

export function clearSlotCurrent(logDir: string, slot: string): void {
  rmSync(slotCurrentPath(logDir, slot), { force: true });
}
