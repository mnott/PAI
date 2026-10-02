/**
 * The one contract every embedding backend implements. One module per
 * backend next to this file; backends.ts registers them.
 *
 * Vectors from different backends are NOT interchangeable (q8-CPU vs F16
 * differ by cosine ~0.97), so an index is bound to the backend that produced
 * its vectors (see ../embedding-binding.ts).
 *
 * Seam for a future "http" backend (e.g. an MLX server): implement this
 * interface against any /embed-style endpoint and add it to backends.ts.
 */
export interface EmbeddingBackend {
  /** Stable id recorded in the index binding, e.g. "ollama-f16". */
  readonly id: string;
  /** Model the vectors come from (HF id for in-process, server model name otherwise). */
  readonly model: string;
  readonly dims: number;
  /** Context limit in tokens, specials included. */
  readonly maxTokens: number;
  available(): Promise<{ ok: boolean; reason: string }>;
  /** Batched document embedding, L2-normalized, order preserved. No query prefix. */
  embed(texts: string[]): Promise<Float32Array[]>;
}
