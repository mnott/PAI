/**
 * PAI memory indexer — compatibility re-export.
 *
 * This file is the public entry point for "memory/indexer" imports.
 * All implementation has moved to the indexer/ subdirectory.
 */

export type { IndexResult, EmbedResult } from "./indexer/types.js";
export { detectTier } from "./indexer/helpers.js";
export {
  indexFile,
  indexProject,
  indexAll,
  embedChunks,
} from "./indexer/sync.js";
