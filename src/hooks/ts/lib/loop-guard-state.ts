/** loop-guard-state.ts — per-worker loop guard window on disk (<logDir>/loop-guard/<id>.json), shared by the Pre and PostToolUse hooks. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyLoopState, type LoopState } from "./loop-guard.js";

export function loopStateFile(logDir: string, id: string): string {
  return join(logDir, "loop-guard", `${id.replace(/[^\w.-]/g, "_")}.json`);
}

export function loadLoopState(file: string): LoopState {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as LoopState;
    // entries from the earlier key format have no tool prefix: start fresh
    if (Array.isArray(j.window) && j.window.every((k) => typeof k === "string" && k.includes("\t"))) return { window: j.window, outs: j.outs, denials: j.denials, runs: j.runs, prints: j.prints };
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
