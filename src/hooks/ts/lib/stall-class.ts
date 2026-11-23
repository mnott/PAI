/**
 * stall-class.ts — which worker classes the no-edit-stall guard may nudge.
 *
 * The guard decides "code-change worker" from the job's class, not from having write tools: a research or
 * review worker that is granted Edit by default must never be paused for reading. The shipped class list is
 * src/workers/config.ts WORKER_CLASSES; these classes exist to change code. An unknown class name (a
 * user-defined tier class) defaults to "findings": the gate only assumes a commit from classes it knows.
 * A declared deliverable (--deliverable, PAI_WORKER_DELIVERABLE) overrides the class either way.
 */

import { parseDeliverable, type Deliverable } from "../../../workers/deliverable.js";

/** Classes whose job is to change code: no-edit-stall nudges and denies them. Everything else is exempt. */
export const CODE_CHANGING_CLASSES = ["implement", "complex", "simple", "draft"] as const;

/** Does this worker class exist to change code? Unknown names are not (read-only by default). */
export function isCodeChangingClass(cls: string | undefined): boolean {
  return !!cls && (CODE_CHANGING_CLASSES as readonly string[]).includes(cls);
}

/**
 * The deliverable a run works to: the declared value (--deliverable / PAI_WORKER_DELIVERABLE) when it is one,
 * otherwise the class gate's default — code-changing classes work to a commit, everything else to a report.
 */
export function effectiveDeliverable(declared: unknown, className: string | undefined): Deliverable {
  return parseDeliverable(declared) ?? (isCodeChangingClass(className) ? "change" : "findings");
}
