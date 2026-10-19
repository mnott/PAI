/**
 * background-gate.ts — a session's background shell command runs in a visible pane.
 *
 * Operator rule: everything that is not in the session's own pane runs in a pane. A Bash call with
 * run_in_background: true is denied unless its command starts (after leading `cd`s and env
 * assignments) with `pai pane run`, `pai worker run`, `pai plan run` (the plan has its own pane),
 * or `pai build run` / `pai build lock`. Foreground calls and workers (who have a pane) are not
 * touched. Pure: the hook entry passes the tool input and the environment.
 */

import { parseCommand } from "./worker-guard.js";

export const BACKGROUND_DENY_MESSAGE = "Background commands run in a visible pane: `pai pane run --label <what> -- <command>`.";

const ALLOWED: string[][] = [["pane", "run"], ["worker", "run"], ["plan", "run"], ["build", "run"], ["build", "lock"]];
const isAssignment = (w: string): boolean => /^[A-Za-z_]\w*=/.test(w);

function allowedStart(command: string): boolean {
  const segs = parseCommand(command);
  const first = segs.find((s) => s.words.length && s.words[0] !== "cd");
  if (!first) return false;
  let i = 0;
  while (i < first.words.length && isAssignment(first.words[i])) i++;
  const w = first.words.slice(i);
  if (w[0] !== "pai" && !/(^|\/)pai$/.test(w[0] ?? "")) return false;
  return ALLOWED.some(([a, b]) => w[1] === a && w[2] === b);
}

export function backgroundReason(
  input: { run_in_background?: unknown; command?: unknown } | undefined,
  env: Record<string, string | undefined>
): string | null {
  if (env.PAI_WORKER === "1") return null;
  if (input?.run_in_background !== true || typeof input.command !== "string") return null;
  return allowedStart(input.command) ? null : BACKGROUND_DENY_MESSAGE;
}
