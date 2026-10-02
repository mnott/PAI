/**
 * Switch an index to another embedding backend: null every vector in bounded
 * batches, then record the new binding. The normal embed loop refills.
 *
 * Order matters for crash safety. Clearing first leaves the old binding
 * intact until nothing of the old backend's vectors remains, so an
 * interrupted run is resumable (run it again) and never leaves new-backend
 * vectors beside old ones. Recording the binding first would let the embed
 * loop fill NULLs with the new backend while old vectors still exist.
 */

import type { StorageBackend } from "../storage/interface.js";
import type { EmbeddingBackend } from "./backends/types.js";

export async function reembedIndex(
  storage: StorageBackend,
  target: EmbeddingBackend,
  opts: { batchSize?: number; onBatch?: (clearedSoFar: number) => void } = {},
): Promise<number> {
  const batch = opts.batchSize ?? 5000;
  let total = 0;
  for (;;) {
    const n = await storage.clearEmbeddingsBatch(batch);
    if (n === 0) break;
    total += n;
    opts.onBatch?.(total);
  }
  await storage.setEmbeddingBinding({ backend: target.id, model: target.model, dims: target.dims });
  return total;
}
