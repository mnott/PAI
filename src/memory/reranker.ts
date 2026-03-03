/**
 * Cross-encoder reranker for PAI memory search results.
 *
 * Uses Xenova/ms-marco-MiniLM-L-6-v2 — a 22.7M param cross-encoder trained on
 * MS MARCO passage ranking.  The q8 quantized ONNX model is ~23 MB.
 *
 * Cross-encoders score (query, document) pairs jointly, producing more accurate
 * relevance scores than bi-encoder cosine similarity alone.  The trade-off is
 * latency: cross-encoders must score each pair independently, so they are used
 * as a reranking step on top of a fast first-stage retriever (BM25 / cosine).
 *
 * The model is loaded as a lazy singleton — no startup cost until the first
 * rerank call.  Subsequent calls reuse the loaded model.
 *
 * Inspired by QMD's Qwen3-reranker step (tobi/qmd).
 */

import type { SearchResult } from "./search.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _tokenizer: any = null;
let _model: any = null;
let _currentModel: string | null = null;
let _loading: Promise<void> | null = null;

/**
 * Configure the reranker model.
 * Must be called before the first rerank() call if you want a non-default model.
 */
export function configureRerankerModel(model?: string): void {
  const resolved = model?.trim() || DEFAULT_RERANKER_MODEL;
  if (_currentModel !== null && _currentModel !== resolved) {
    _tokenizer = null;
    _model = null;
    _loading = null;
  }
  _currentModel = resolved;
}

async function ensureLoaded(): Promise<void> {
  if (_tokenizer && _model) return;
  if (_loading) return _loading;

  _loading = (async () => {
    const model = _currentModel ?? DEFAULT_RERANKER_MODEL;
    const {
      AutoTokenizer,
      AutoModelForSequenceClassification,
    } = await import("@huggingface/transformers");

    _tokenizer = await AutoTokenizer.from_pretrained(model);
    _model = await AutoModelForSequenceClassification.from_pretrained(
      model,
      { dtype: "q8" },
    );
    _currentModel = model;
  })();

  return _loading;
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

export interface RerankOptions {
  /** Maximum number of results to return after reranking. */
  topK?: number;
  /**
   * Maximum number of candidates to rerank.
   * Cross-encoders are O(n) per candidate, so we cap to keep latency
   * reasonable.  Default: 50.
   */
  maxCandidates?: number;
}

/**
 * Rerank search results using a cross-encoder model.
 *
 * Takes the top `maxCandidates` results from a first-stage retriever,
 * scores each (query, snippet) pair through the cross-encoder, and
 * returns them sorted by cross-encoder relevance score.
 *
 * The original retrieval score is replaced with the cross-encoder score.
 */
export async function rerankResults(
  query: string,
  results: SearchResult[],
  opts?: RerankOptions,
): Promise<SearchResult[]> {
  if (results.length === 0) return [];

  const maxCandidates = opts?.maxCandidates ?? 50;
  const topK = opts?.topK ?? results.length;

  // Cap candidates to rerank
  const candidates = results.slice(0, maxCandidates);

  await ensureLoaded();

  // Tokenize all (query, document) pairs in a single batch
  const queries = new Array(candidates.length).fill(query);
  const documents = candidates.map((r) => r.snippet);

  const inputs = _tokenizer!(queries, {
    text_pair: documents,
    padding: true,
    truncation: true,
  });

  // Run the cross-encoder
  const output = await _model!(inputs);
  const logits = output.logits;

  // ms-marco-MiniLM returns raw logits (not sigmoid-normalized).
  // Higher = more relevant.
  const scores: number[][] = logits.tolist();

  // Build reranked results
  const scored = candidates.map((result, i) => ({
    ...result,
    score: scores[i][0],
  }));

  // Sort by cross-encoder score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}
