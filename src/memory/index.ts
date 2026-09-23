/**
 * PAI memory engine — Phase 2
 *
 * Federated BM25 full-text search across all registered project memory files.
 *
 * Re-exports the public API from all memory sub-modules.
 */

export { chunkMarkdown, estimateTokens } from "./chunker.js";
export type { Chunk, ChunkOptions } from "./chunker.js";
export { detectTier } from "./indexer/helpers.js";
export type { IndexResult } from "./indexer/types.js";
export { buildFtsQuery, populateSlugs } from "./search.js";
export type { SearchResult, SearchOptions } from "./search.js";
export { rerankResults, configureRerankerModel } from "./reranker.js";
export type { RerankOptions } from "./reranker.js";
