/**
 * src/observations/index.ts — Public API for the observations module.
 *
 * Re-exports the classifier (pure functions). Storage lives behind
 * StorageBackend (src/storage/postgres/observations.ts) — see
 * StorageBackend.storeObservation/queryObservations/etc.
 */

export { classifyToolEvent } from './classifier.js';
export type { RawToolEvent, ClassifiedObservation } from './classifier.js';
