/**
 * Shared types for the PAI memory indexer.
 */

export interface IndexResult {
  filesProcessed: number;
  chunksCreated: number;
  filesSkipped: number;
}

export interface EmbedResult {
  chunksEmbedded: number;
  chunksSkipped: number;
}
