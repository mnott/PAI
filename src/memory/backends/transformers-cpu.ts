/** In-process transformers.js, q8, CPU. The original backend; vectors unchanged. */

import type { EmbeddingBackend } from "./types.js";
import { EMBEDDING_DIM, configureEmbeddingModel, generateEmbeddings } from "../embeddings.js";

export const TRANSFORMERS_ID = "transformers-cpu-q8";

export function createTransformersBackend(model: string): EmbeddingBackend {
  return {
    id: TRANSFORMERS_ID,
    model,
    dims: EMBEDDING_DIM,
    maxTokens: 512,
    async available() {
      return { ok: true, reason: "in-process CPU (q8), no server needed" };
    },
    async embed(texts) {
      configureEmbeddingModel(model);
      return generateEmbeddings(texts);
    },
  };
}
