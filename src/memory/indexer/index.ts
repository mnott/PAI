/**
 * PAI memory indexer — barrel re-export.
 *
 * Re-exports the public API from the indexer sub-modules so that
 * external imports of "memory/indexer" continue to work unchanged.
 *
 * The SQLite-specific synchronous indexer moved to storage/sqlite/indexer.ts
 * (StorageBackend.indexAll()) — every caller now goes through the
 * backend-agnostic API below regardless of which backend is active.
 */

// Types
export type { IndexResult, EmbedResult } from "./types.js";

// Helpers (exported for consumers that need tier detection, etc.)
export { detectTier } from "./helpers.js";

// Async (StorageBackend) indexer — public API
export {
  indexFileWithBackend,
  indexProjectWithBackend,
  indexAllWithBackend,
  embedChunksWithBackend,
} from "./async.js";
