/**
 * Embedding generation for the PAI federation memory engine (Phase 2.5).
 *
 * Uses @huggingface/transformers with the Snowflake/snowflake-arctic-embed-m-v1.5 model
 * (768 dims, q8 quantization, MTEB strong retrieval quality).
 *
 * The model uses CLS pooling (first token) — NOT mean pooling.
 * For retrieval, queries require a prefix: "Represent this sentence for searching relevant passages: "
 * Documents should be embedded WITHOUT a prefix.
 *
 * The pipeline is a lazy singleton — loaded on first call, reused thereafter.
 * This avoids loading the heavy ML model on every CLI invocation.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMBEDDING_DIM = 768;
const DEFAULT_EMBEDDING_MODEL = "Snowflake/snowflake-arctic-embed-m-v1.5";

/** Query prefix required by Snowflake Arctic Embed for retrieval tasks. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// ---------------------------------------------------------------------------
// Lazy pipeline singleton
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embeddingPipeline: any = null;
let _currentModel: string | null = null;

/**
 * Configure the embedding model to use.
 * Must be called before the first generateEmbedding() call.
 * If the pipeline is already loaded with a different model, it will be reloaded.
 *
 * @param model  HuggingFace model ID (e.g. "Snowflake/snowflake-arctic-embed-m-v1.5").
 *               Pass undefined or empty string to use the default model.
 */
export function configureEmbeddingModel(model?: string): void {
  const resolved = model?.trim() || DEFAULT_EMBEDDING_MODEL;
  if (_currentModel !== null && _currentModel !== resolved) {
    // Model changed — force reload on next call
    _embeddingPipeline = null;
  }
  _currentModel = resolved;
}

async function getEmbedder() {
  const model = _currentModel ?? DEFAULT_EMBEDDING_MODEL;
  if (!_embeddingPipeline) {
    // Dynamic import to avoid loading the ML runtime on startup
    const { pipeline } = await import("@huggingface/transformers");
    _embeddingPipeline = await pipeline(
      "feature-extraction",
      model,
      { dtype: "q8" },
    );
  }
  return _embeddingPipeline;
}

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

/**
 * Generate a normalized 768-dim embedding for the given text.
 *
 * Uses CLS pooling (first token) and L2 normalization (cosine similarity ready).
 *
 * @param text     The text to embed.
 * @param isQuery  If true, prepend the Snowflake query prefix. Use for search queries.
 *                 Documents should be embedded without the prefix (default: false).
 */
export async function generateEmbedding(text: string, isQuery: boolean = false): Promise<Float32Array> {
  const prefix = isQuery ? QUERY_PREFIX : "";
  const input = prefix + text;
  const extractor = await getEmbedder();
  // Snowflake Arctic Embed uses CLS pooling (first token), not mean pooling
  const output = await extractor(input, { pooling: "cls", normalize: true });
  return new Float32Array(output.data);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a Float32Array to a Buffer for storage in a SQLite BLOB column.
 */
export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a Buffer (from a SQLite BLOB column) back into a Float32Array.
 */
export function deserializeEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Similarity computation
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two normalized embedding vectors.
 *
 * Since both vectors are already L2-normalized by the embedding model,
 * cosine similarity reduces to a dot product — but we compute the full
 * formula for correctness when embeddings may not be pre-normalized.
 *
 * Returns a value in [-1, 1] where 1 = identical.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
