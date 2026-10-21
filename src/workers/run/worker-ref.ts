/**
 * run/worker-ref.ts — late-bound reference to runWorker (split plan step 9).
 * runWorker sits at the top of the module graph and calls the escalation and
 * execute modules, which call it back for a re-run; they import this alias
 * instead of worker.ts to avoid an import cycle. run.ts registers the real
 * function once at load.
 */

import type { RunOptions } from "./types.js";

let impl: ((opts: RunOptions) => Promise<number>) | undefined;

export function setRunWorker(fn: (opts: RunOptions) => Promise<number>): void {
  impl = fn;
}

export function runWorker(opts: RunOptions): Promise<number> {
  if (!impl) throw new Error("runWorker not registered");
  return impl(opts);
}
