/**
 * Index ↔ backend binding rules. Dependency-free so the storage layer can
 * import it.
 */

import type { EmbeddingBinding } from "../storage/interface.js";

/**
 * What an index holding vectors but no recorded binding is: it predates
 * binding, so its vectors are transformers-cpu-q8. Model and dims are unknown
 * ("" / 0 = wildcard) and are filled in on the first embed that adopts it.
 */
export const LEGACY_EMBEDDING_BINDING: EmbeddingBinding = {
  backend: "transformers-cpu-q8",
  model: "",
  dims: 0,
};

export function isInferredBinding(b: EmbeddingBinding): boolean {
  return b.model === "";
}

export function bindingMatches(b: EmbeddingBinding, cur: { id: string; model: string; dims: number }): boolean {
  return (
    b.backend === cur.id &&
    (b.model === "" || b.model === cur.model) &&
    (b.dims === 0 || b.dims === cur.dims)
  );
}

export function describeBinding(b: { backend: string; model: string }): string {
  return b.model ? `${b.backend} (${b.model})` : b.backend;
}
