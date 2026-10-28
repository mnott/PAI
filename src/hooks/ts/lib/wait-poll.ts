/**
 * wait-poll.ts — the ONE predicate for "this Bash call is a wait whose non-zero
 * exit is its documented answer, not a failure".
 *
 * Two copies used to decide this: loop-guard's `isPollCommand` (door-aware: a
 * build door registered in `.pai/builds.yaml` run with `--wait`, `pai build
 * run|lock`, `pai worker wait*`) and wait.ts's `isWaitPollCommand` (wait verbs
 * only), which fed tool-errors' `isBenignBash` and repeat-loop's
 * `detectRepeatLoop`. A registered door's exit-3 poll was a wait for the loop
 * guard but a failure for supervision — every `sh tools/build.sh ios --wait`
 * poll pushed a tool error and tripped the repeat-loop alert. This module is
 * the single source: the door-aware command shape plus the exit-3 check.
 *
 * Lives in hooks/ts/lib because the door reader (`build-gate.ts`) is there and
 * must stay import-light for the PreToolUse hook; `src/workers` may import
 * `src/hooks/ts/lib` (the existing direction — tool-errors already imports
 * heredoc and render-decision), never the reverse.
 */

import { isAbsolute, resolve } from "node:path";
import { loadBuildsConfig, runsDoor, splitSegments, type BuildsConfig } from "./build-gate.js";

/** Exit code of every wait verb / build-door `--wait` that means "not yet, call again". */
export const WAIT_EXIT_STILL_RUNNING = 3;

const POLL_VERB = /^(?:pai\s+build\s+(?:run|lock)|pai\s+worker\s+wait[\w-]*)\b/;

const doorCache = new Map<string, BuildsConfig | null>();
function doorsAt(dir: string): BuildsConfig | null {
  const key = resolve(dir);
  if (!doorCache.has(key)) doorCache.set(key, loadBuildsConfig(key));
  return doorCache.get(key) ?? null;
}

/**
 * A poll waits for something else: anywhere in the command line (cd prefixes,
 * pipes, && chains) it invokes a build door registered in the repo's
 * `.pai/builds.yaml` with `--wait` — through `sh`/`bash`/`./` as well — or
 * `pai build run|lock`, or `pai worker wait*`.
 * With no `cwd` the door list cannot be read: a command naming a script
 * registered nowhere stays a non-poll (no guessing).
 */
export function isPollCommand(command: string, cwd: string = process.cwd()): boolean {
  let dir = cwd;
  for (const seg of splitSegments(command)) {
    const ws = seg.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")).filter(Boolean);
    if (ws[0] === "cd" && ws[1]) {
      dir = isAbsolute(ws[1]) ? ws[1] : resolve(dir, ws[1]);
      continue;
    }
    if (POLL_VERB.test(ws.join(" ").replace(/^(?:[A-Za-z_]\w*=\S*\s+|nohup\s+)+/, ""))) return true;
    if (!ws.includes("--wait")) continue;
    if (runsDoor(ws, dir, doorsAt(dir))) return true;
  }
  return false;
}

/** A poll that exited with its documented "still running" code: an answer, not an error. */
export function isExpectedWaitExit(command: string, exitCode: number | null, cwd?: string): boolean {
  return exitCode === WAIT_EXIT_STILL_RUNNING && isPollCommand(command, cwd ?? process.cwd());
}
