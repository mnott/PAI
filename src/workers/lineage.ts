/**
 * lineage.ts — a rerouted/escalated run and its continuations (A -> B -> C, same branch) are one piece of work.
 * Ancestors are found through the continuation's `fallThroughOf` back-links; when a continuation is merged every
 * ancestor is marked `supersededBy` it, so pending hides them and gc may discard them.
 */

import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

const MAX_HOPS = 16;

/** The runs `st` continues, nearest first (its origin, that one's origin, ...). */
export function ancestorsOf(logDir: string, st: Pick<WorkerStatus, "id" | "fallThroughOf">): WorkerStatus[] {
  const out: WorkerStatus[] = [];
  const seen = new Set<string>([st.id]);
  let of = st.fallThroughOf;
  for (let i = 0; of && !seen.has(of) && i < MAX_HOPS; i++) {
    seen.add(of);
    const a = loadStatus(logDir, of);
    if (!a) break;
    out.push(a);
    of = a.fallThroughOf;
  }
  return out;
}

/** The first run of the lineage `st` belongs to (st itself when it continues nothing). */
export function lineageRoot(logDir: string, st: WorkerStatus): WorkerStatus {
  const a = ancestorsOf(logDir, st);
  return a.length ? a[a.length - 1]! : st;
}

/** Mark every ancestor of the merged run `st` as superseded by it; returns the marked ids. */
export function markSuperseded(logDir: string, st: Pick<WorkerStatus, "id" | "fallThroughOf">): string[] {
  const done: string[] = [];
  for (const a of ancestorsOf(logDir, st)) {
    if (a.supersededBy === st.id) continue;
    saveStatus(logDir, { ...a, supersededBy: st.id });
    done.push(a.id);
  }
  return done;
}
