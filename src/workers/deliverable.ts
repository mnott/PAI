/**
 * deliverable.ts — what a worker's result IS, declared at run start.
 *
 * "change": the job exists to change code; its result is a commit on its branch.
 * "findings": the job exists to answer; its result is a report, it may write
 * scratch anywhere, and no commit is expected of it.
 *
 * Declared explicitly (`pai worker run --deliverable …`) or inherited through
 * PAI_WORKER_DELIVERABLE from the spawner; when neither is set the class gate
 * decides (code-changing classes default to "change", everything else to
 * "findings"). This replaces the keyword markers a brief used to carry.
 */

/** The declared deliverables. */
export const DELIVERABLES = ["change", "findings"] as const;

/** What a worker's result is: a repo commit, or a report. */
export type Deliverable = (typeof DELIVERABLES)[number];

/** Is this value one of the declared deliverables? */
export function isDeliverable(v: unknown): v is Deliverable {
  return typeof v === "string" && (DELIVERABLES as readonly string[]).includes(v);
}

/** Parse a --deliverable / env value; anything else is undefined (fall back to the class gate). */
export function parseDeliverable(v: unknown): Deliverable | undefined {
  return isDeliverable(v) ? v : undefined;
}
