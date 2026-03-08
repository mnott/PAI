/**
 * PAI memory indexer — barrel re-export.
 *
 * Re-exports the public API from the indexer sub-modules so that
 * external imports of "memory/indexer" continue to work unchanged.
 */

// Types
export type { IndexResult, EmbedResult } from "./types.js";

// Helpers (exported for consumers that need tier detection, etc.)
export { detectTier } from "./helpers.js";

// Sync (SQLite) indexer — public API
export {
  indexFile,
  indexProject,
  indexAll,
  embedChunks,
} from "./sync.js";

// Async (StorageBackend) indexer — public API
export {
  indexFileWithBackend,
  indexProjectWithBackend,
  indexAllWithBackend,
  embedChunksWithBackend,
} from "./async.js";
