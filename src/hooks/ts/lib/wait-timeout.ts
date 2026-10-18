/**
 * wait-timeout.ts — raise the Bash tool timeout for long `pai worker wait*` calls.
 *
 * The wait verbs accept --max up to 590 s, but Claude Code's Bash tool kills a
 * call at 120 s unless `timeout` is passed, and models do not reliably pass it.
 * Used by both PreToolUse entries (worker and interactive session) so the rule
 * lives in one place.
 */

import { dropHeredocBodies } from "./heredoc.js";

/** Waits up to this long fit in the default 120 s Bash timeout. */
const DEFAULT_SAFE_SECS = 110;
const MAX_TIMEOUT_MS = 600_000;
const SLACK_SECS = 15;

const WAIT_MAX = /\bpai\s+worker\s+wait(?:-on|-url|-file)?\b[^\n;|&]*?--max[=\s]+(\d+)/g;

/** The tool_input with `timeout` raised to cover the longest `pai worker wait* --max N`; null when nothing needs raising. */
export function raiseWaitTimeout(toolInput: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const command = toolInput?.command;
  if (typeof command !== "string") return null;
  let longest = 0;
  for (const m of dropHeredocBodies(command).matchAll(WAIT_MAX)) longest = Math.max(longest, Number(m[1]));
  if (longest <= DEFAULT_SAFE_SECS) return null;
  const want = Math.min(MAX_TIMEOUT_MS, (longest + SLACK_SECS) * 1000);
  const have = toolInput?.timeout;
  if (typeof have === "number" && have >= want) return null;
  return { ...toolInput, timeout: want };
}
