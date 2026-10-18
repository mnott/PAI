/**
 * loop-guard.ts — repeat detection for worker Bash commands.
 *
 * A worker that re-runs the exact same command with nothing changed in between
 * is stuck (seen: 68x one probe, 12x one vitest run after committing, 9x an
 * A/B proof alternation, 6x one sed read). The window is the Bash commands
 * since the last Edit/Write/MultiEdit/NotebookEdit; the 5th copy of a command
 * is denied. Alternating A,B,A,B is covered the same way: each of the two
 * commands reaches 4 copies in the window, so the next of either is denied.
 * Different sed ranges are different commands and never repeat.
 */

export const LOOP_MAX_REPEATS = 4;
const WINDOW_CAP = 64;

export const LOOP_DENY_REASON =
  "loop guard: you ran this exact command 4 times without changing anything. Stop repeating it. If your part is done, commit and write your R report. If you are stuck, report the blocker in R x= (or use pai worker help if available).";

export interface LoopState {
  /** Normalised commands run since the last edit, oldest first. */
  window: string[];
}

export function emptyLoopState(): LoopState {
  return { window: [] };
}

/** Whitespace-normalised; digits inside /tmp/... paths collapsed so a numbered output file does not hide a repeat. */
export function loopKey(command: string): string {
  return command
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\/private)?\/tmp\/[^\s'";|&<>)]*/g, (p) => p.replace(/\d+/g, "N"));
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Next state and whether this tool call is a loop repeat to deny. */
export function stepLoopGuard(state: LoopState, tool: string, command?: string): { state: LoopState; deny: boolean } {
  if (EDIT_TOOLS.has(tool)) return { state: emptyLoopState(), deny: false };
  if (tool !== "Bash" || typeof command !== "string" || !command.trim()) return { state, deny: false };
  const key = loopKey(command);
  const copies = state.window.filter((k) => k === key).length;
  if (copies >= LOOP_MAX_REPEATS) return { state, deny: true };
  return { state: { window: [...state.window, key].slice(-WINDOW_CAP) }, deny: false };
}
