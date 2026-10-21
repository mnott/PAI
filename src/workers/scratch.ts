/**
 * Per-worker scratch dir: concurrent workers share one /tmp, and a fixed name
 * there (/tmp/edit.py) is one worker's script running in another's tree.
 * Each run gets <logDir>/scratch/<id>, exported as TMPDIR; discard and gc remove it.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function scratchDir(logDir: string, id: string): string {
  return join(logDir, "scratch", id);
}

/** Create the dir and point TMPDIR at it. */
export function applyScratchEnv(env: Record<string, string | undefined>, logDir: string, id: string): string {
  const dir = scratchDir(logDir, id);
  mkdirSync(dir, { recursive: true });
  env.TMPDIR = dir;
  return dir;
}

export function removeScratch(logDir: string, id: string): void {
  rmSync(scratchDir(logDir, id), { recursive: true, force: true });
}
