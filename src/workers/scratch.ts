/**
 * Per-worker scratch dir: concurrent workers share one /tmp, and a fixed name
 * there (/tmp/edit.py) is one worker's script running in another's tree.
 * Each run gets <systmp>/pai-scratch/<id>, exported as TMPDIR; discard and gc remove it.
 * It lives under the system temp dir, never the log dir: that sits inside a git
 * repo, and tools that assume tmpdir is outside any repo break there.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function scratchDir(id: string): string {
  return join(tmpdir(), "pai-scratch", id);
}

/** Create the dir (mode 0700) and point TMPDIR at it. */
export function applyScratchEnv(env: Record<string, string | undefined>, id: string): string {
  const dir = scratchDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  env.TMPDIR = dir;
  return dir;
}

export function removeScratch(id: string): void {
  rmSync(scratchDir(id), { recursive: true, force: true });
}

/** Prompt line stating the scratch dir literally: Write/Edit do not expand $TMPDIR and would create a folder named "$TMPDIR". */
export function scratchPromptLine(dir: string): string {
  return `Scratch dir: ${dir} — use this absolute path in Write/Edit; the Write tool does not expand $TMPDIR (Bash does).`;
}
