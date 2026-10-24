/**
 * Carry stored vectors over to chunks whose text is already embedded.
 *
 * The embedder sees only the chunk text, so the vector of a chunk is a function
 * of its text hash. A re-chunked file, a moved file, or a project that came back
 * with a new id (chunk ids and file rows are keyed by project id) therefore never
 * has to queue text it has already embedded.
 */

import type { ChunkRow, StorageBackend } from "../../storage/interface.js";

/** `chunks` with the vector of every chunk whose text hash already has one. */
export async function withCarriedEmbeddings(
  backend: Pick<StorageBackend, "getEmbeddingsByHash">,
  chunks: ChunkRow[],
): Promise<ChunkRow[]> {
  const todo = chunks.filter((c) => !c.embedding);
  if (todo.length === 0) return chunks;
  const known = await backend.getEmbeddingsByHash(todo.map((c) => c.hash));
  if (known.size === 0) return chunks;
  return chunks.map((c) => (c.embedding ? c : { ...c, embedding: known.get(c.hash) ?? null }));
}
