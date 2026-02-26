/**
 * PAI memory engine — Phase 2
 *
 * Federated BM25 full-text search across all registered project memory files.
 *
 * Re-exports the public API from all memory sub-modules.
 */

export { FEDERATION_SCHEMA_SQL, initializeFederationSchema } from "./schema.js";
export { openFederation } from "./db.js";
export type { Database } from "./db.js";
export { chunkMarkdown, estimateTokens } from "./chunker.js";
export type { Chunk, ChunkOptions } from "./chunker.js";
export {
  indexFile,
  indexProject,
  indexAll,
  detectTier,
} from "./indexer.js";
export type { IndexResult } from "./indexer.js";
export { searchMemory, buildFtsQuery, populateSlugs } from "./search.js";
export type { SearchResult, SearchOptions } from "./search.js";
