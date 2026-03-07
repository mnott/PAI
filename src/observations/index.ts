/**
 * src/observations/index.ts — Public API for the observations module.
 *
 * Re-exports the classifier (pure functions) and the Postgres store
 * (accepts a pg.Pool, no internal connection management).
 */

export { classifyToolEvent } from './classifier.js';
export type { RawToolEvent, ClassifiedObservation } from './classifier.js';
export * from './store.js';
