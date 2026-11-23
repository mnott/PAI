/** loop-guard-state.ts — per-worker loop guard window on disk (<logDir>/loop-guard/<id>.json), shared by the Pre and PostToolUse hooks. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyLoopState, type LoopState } from "./loop-guard.js";

export function loopStateFile(logDir: string, id: string): string {
  return join(logDir, "loop-guard", `${id.replace(/[^\w.-]/g, "_")}.json`);
}

export function loadLoopState(file: string): LoopState {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as LoopState;
    // entries from the earlier key format have no tool prefix: start fresh
    if (Array.isArray(j.window) && j.window.every((k) => typeof k === "string" && k.includes("\t"))) return { ...emptyLoopState(), ...j };
  } catch {
    // first call or damaged state: start a fresh window
  }
  return emptyLoopState();
}

export function saveLoopState(file: string, state: LoopState): void {
  const dir = join(file, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

/** Appends one line to the worker's hook error log (<logDir>/hook-errors/<id>.log). Never throws. */
export function logHookError(logDir: string, id: string, hook: string, err: unknown): void {
  try {
    const dir = join(logDir, "hook-errors");
    mkdirSync(dir, { recursive: true });
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(join(dir, `${id.replace(/[^\w.-]/g, "_")}.log`), `${new Date().toISOString()} ${hook}: ${msg.replace(/\n/g, " | ")}\n`);
  } catch {
    // the log itself is best effort
  }
}
