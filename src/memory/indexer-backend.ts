/**
 * PAI memory indexer backend — compatibility re-export.
 *
 * This file is the public entry point for "memory/indexer-backend" imports.
 * All implementation has moved to the indexer/ subdirectory.
 */

export type { IndexResult } from "./indexer/types.js";
export {
  indexFileWithBackend,
  indexProjectWithBackend,
  indexAllWithBackend,
  embedChunksWithBackend,
} from "./indexer/async.js";

/**
 * Parse a session title from a Notes filename.
 * @deprecated Import from indexer/helpers.js or use parseSessionTitleChunk from there.
 */
export { parseSessionTitleChunk } from "./indexer/helpers.js";
