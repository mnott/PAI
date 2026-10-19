/**
 * result-grace.ts — end a headless claude that outlives its final result.
 *
 * Headless Claude Code waits for background Bash tasks before it exits, so a
 * leftover `sleep`/scan can keep the run "running" long after the result event.
 * After the result the process gets a short grace to exit by itself; if it has
 * not, everything below it and then claude itself is terminated.
 */

import { processTree, killProcessTree } from "./wait-on.js";

export const RESULT_GRACE_MS = 20_000;

export interface ResultGraceDeps {
  /** Pids below `pid` (not `pid` itself). */
  descendants: (pid: number) => number[];
  /** End `pid` and its whole tree. */
  terminate: (pid: number) => Promise<void>;
}

const defaultDeps: ResultGraceDeps = {
  descendants: (pid) => processTree(pid).slice(1),
  terminate: (pid) => killProcessTree(pid),
};

export interface ResultGrace {
  /** The final result event arrived: (re)start the grace clock. */
  onResult(): void;
  /** More work is coming (operator input) or the process exited: stop the clock. */
  cancel(): void;
  /** Resolves once a fired grace has finished terminating; the leftover count. */
  readonly leftover: number;
  readonly fired: boolean;
  settled(): Promise<void>;
}

export function armResultGrace(
  pid: number | undefined,
  graceMs = RESULT_GRACE_MS,
  deps: ResultGraceDeps = defaultDeps
): ResultGrace {
  let timer: NodeJS.Timeout | null = null;
  let done: Promise<void> = Promise.resolve();
  const g = {
    leftover: 0,
    fired: false,
    onResult() {
      if (!pid || g.fired) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        g.fired = true;
        g.leftover = deps.descendants(pid).length;
        done = deps.terminate(pid).catch(() => undefined);
      }, graceMs);
      timer.unref?.();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    settled: () => done,
  };
  return g;
}

export function leftoverNote(n: number): string {
  return `finished; ended ${n} leftover background process(es)`;
}
