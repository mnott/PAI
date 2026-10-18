/**
 * sleep-poll-gate.ts — the decision behind the PreToolUse Bash sleep-poll gate.
 *
 * Pure: no stdin, no filesystem, no process.env read of its own — the hook
 * entry (pre-tool-use/block-sleep-poll.ts) does the I/O, this module decides,
 * same split as lib/agent-gate.ts and lib/edit-gate.ts.
 *
 * CLAUDE.md already says "never sleep-poll"; prose does not enforce it, a
 * PreToolUse deny does. `run_in_background: true` is allowed in an interactive session (denied in a worker) — a
 * backgrounded sleep blocks nothing, it is the harness's own long-command
 * pattern.
 */

import { totalSleepSecs } from "../../../workers/status.js";
import { WAIT_RECIPE, WAIT_VERBS } from "../../../workers/wait-on.js";

export interface SleepPollGateInput {
  tool_name?: string;
  tool_input?: { command?: string; run_in_background?: boolean };
}

/** An allow may rewrite the tool input and tell the model why (`updatedInput`, `additionalContext`). */
import { type GateDecision } from "./render-decision.js";
export type { GateDecision };

/** Longest total sleep a command may carry: a single `sleep N` with N <= 60, or several summing to <= 60. */
export const SLEEP_ALLOWED_SECS = 60;

const WORKER_ID_RE = /\b(?:w-)?\d{8}-\d{6}-\d+\b|\bw-\d{8}-\w+\b/g;
const URL_RE = /https?:\/\/[^\s"'`;|&)]+/;
const unquote = (t: string): string => t.replace(/^["']|["']$/g, "");

/** The thing a blocked command is visibly waiting for, with the verb call that waits for it. */
function waitHint(command: string, maxArg: string): string | null {
  const ids = [...new Set(command.match(WORKER_ID_RE) ?? [])];
  if (/\bpai\s+worker\s+(?:ps|log|status)\b/.test(command) || ids.length > 0) {
    return `this waits for child workers: \`pai worker wait ${ids.length ? ids.join(" ") : "<id...>"}${maxArg}\` returns when any finishes (one status line per id, exit 0 all done, 3 still running: call again with the unfinished ids)`;
  }
  const url = command.match(URL_RE)?.[0];
  const port = command.match(/\blsof\b[^;|&\n]*?:(\d{2,5})\b|\bnc\b[^;|&\n]*?\s(\d{2,5})\b/);
  if (/\b(curl|wget)\b/.test(command) && url) {
    return `this waits for a server: \`pai worker wait-url ${url}${maxArg}\` (exit 0 up, 3 not yet: call again)`;
  }
  if (port || /\b(curl|wget)\b/.test(command)) {
    const p = port?.[1] ?? port?.[2];
    return `this waits for a server: \`pai worker wait-url ${p ? `http://127.0.0.1:${p}/` : "<url>"}${maxArg}\` (exit 0 up, 3 not yet: call again)`;
  }
  const pid = command.match(/\$\(cat\s+(\S+?\.pid)\)|\bkill\s+-0\s+(\d+)|\bps\s+-p\s+(\d+)/);
  if (pid) {
    const arg = pid[1] ? `$(cat ${pid[1]})` : (pid[2] ?? pid[3]);
    return `this waits for a detached job: \`pai worker wait-on ${arg}${maxArg}\` (exit 0 gone, 3 still running: call again)`;
  }
  const paths = filePaths(command);
  if (paths) {
    return `this waits for a file: \`pai worker wait-file ${paths}${maxArg}\` (exit 0 all exist, 3 not yet: call again)`;
  }
  return null;
}

/** Paths a `ls`, `test -f`, `[ -f ]` or `grep -q PAT FILE` in the command looks at, space-joined; null when none. */
function filePaths(command: string): string | null {
  const found: string[] = [];
  for (const m of command.matchAll(/(?:\bls|\btest\s+-[fes]|\[\s+-[fes])\s+((?:[^\s;|&<>\]]+\s*)+)/g)) {
    for (const t of m[1].trim().split(/\s+/)) if (!t.startsWith("-")) found.push(unquote(t));
  }
  for (const m of command.matchAll(/\bgrep\s+(?:-\w+\s+)*(?:'[^']*'|"[^"]*"|\S+)\s+(\/\S+|~\/\S+|\.\/\S+)/g)) found.push(unquote(m[1]));
  const clean = [...new Set(found)].filter((p) => /[\/.]/.test(p));
  return clean.length ? clean.join(" ") : null;
}

/**
 * A headless worker has no owner to deliver a background-exit notification
 * to — ending its turn ends the process, so the interactive session's advice
 * ("background it, the harness notifies you") does not apply. The message names
 * the wait verb for what the command is visibly waiting for (see waitHint),
 * falling back to the full verb list and the detached-job recipe, so a denied
 * worker sees one copy-pasteable call instead of a generic lecture.
 */
export function denyReason(secs: number, isWorker: boolean, command = ""): string {
  const lead = `sleep ${secs}s blocked: do not sleep-poll (a single sleep up to ${SLEEP_ALLOWED_SECS}s is fine). `;
  if (isWorker) {
    const hint = waitHint(command, " --max 100");
    if (hint) return lead + `Seen: ${hint}. run_in_background is denied here.`;
    return lead + `${WAIT_VERBS} For a long job of your own, run it detached: ${WAIT_RECIPE}. run_in_background is denied here.`;
  }
  return (
    lead +
    "Run the long command itself with run_in_background: true (the harness notifies when it exits), " +
    "or wait on a specific condition with a bounded loop under 60s per step."
  );
}

/**
 * A headless worker (`claude -p`) has no re-invocation: ending its turn ends
 * the process and kills the background job, whatever it says about waiting for
 * a completion notification.
 */
const BACKGROUND_WORKER_REASON =
  "run_in_background is blocked in a worker: ending your turn ends this process and kills the job, " +
  "there is no completion notification. " +
  WAIT_VERBS + " For a long job of your own, run it detached: " + WAIT_RECIPE + ".";

/**
 * The command with heredoc bodies and quoted strings blanked: a `sleep N`
 * written inside a heredoc, a JS/python source or an `echo '...'` is text, not
 * a command position, and must not count. (A `sh -c '...sleep...'` payload is
 * blanked too; the documented detached recipe runs its own bounded loop there.)
 */
export function stripQuotedText(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let tag: string | null = null;
  for (const line of lines) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    kept.push(line);
    const h = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/);
    if (h) tag = h[1] ?? h[2] ?? h[3];
  }
  return kept
    .join("\n")
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function decideSleepPollGate(
  input: SleepPollGateInput,
  env: Record<string, string | undefined>
): GateDecision {
  if (input.tool_name && input.tool_name !== "Bash") return { decision: "allow" };
  const isWorker = env.PAI_WORKER === "1";
  if (input.tool_input?.run_in_background === true) {
    return isWorker ? { decision: "deny", reason: BACKGROUND_WORKER_REASON } : { decision: "allow" };
  }

  const command = input.tool_input?.command;
  if (typeof command !== "string") return { decision: "allow" };

  const secs = totalSleepSecs(stripQuotedText(command));
  if (secs <= SLEEP_ALLOWED_SECS) return { decision: "allow" };

  return { decision: "deny", reason: denyReason(secs, isWorker, command) };
}
