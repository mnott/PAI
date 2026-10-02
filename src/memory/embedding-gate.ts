/**
 * The single entry point for embedding against an index: the configured
 * backend, checked against the backend the index's vectors came from.
 *
 * Mismatch or an unavailable backend never falls back to another backend:
 * embedding pauses (chunks stay NULL) and queries go keyword-only with a note.
 */

import type { StorageBackend } from "../storage/interface.js";
import type { EmbeddingBackend } from "./backends/types.js";
import { getConfiguredBackend } from "./backends/index.js";
import { bindingMatches, isInferredBinding, mismatchReason } from "./embedding-binding.js";

export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export type Gate =
  | { ok: true; backend: EmbeddingBackend }
  | { ok: false; kind: "mismatch" | "unavailable"; reason: string };

/**
 * @param record  Writing vectors: record (or complete) the index binding. Pass
 *                false for queries, which must not touch the binding.
 */
export async function gateBackend(
  storage: StorageBackend,
  opts: { record: boolean; backend?: EmbeddingBackend },
): Promise<Gate> {
  const backend = opts.backend ?? getConfiguredBackend();
  const binding = await storage.getEmbeddingBinding();

  if (binding && !bindingMatches(binding, backend)) {
    return {
      ok: false,
      kind: "mismatch",
      reason: mismatchReason(binding, backend),
    };
  }
  const avail = await backend.available();
  if (!avail.ok) {
    return { ok: false, kind: "unavailable", reason: `embedding backend ${backend.id} unavailable: ${avail.reason}` };
  }
  if (opts.record && (!binding || isInferredBinding(binding))) {
    await storage.setEmbeddingBinding({ backend: backend.id, model: backend.model, dims: backend.dims });
  }
  return { ok: true, backend };
}

/** Query embedding, or null plus a note to show next to the keyword-only results. */
export async function embedQuery(
  storage: StorageBackend,
  text: string,
  backend?: EmbeddingBackend,
): Promise<{ vec: Float32Array; note?: undefined } | { vec: null; note: string }> {
  const gate = await gateBackend(storage, { record: false, backend });
  if (!gate.ok) return { vec: null, note: `${gate.reason}. Results are keyword-only.` };
  try {
    const [vec] = await gate.backend.embed([QUERY_PREFIX + text]);
    return { vec };
  } catch (e) {
    return { vec: null, note: `query embedding failed (${e instanceof Error ? e.message : String(e)}). Results are keyword-only.` };
  }
}

/** For callers with no keyword fallback (zettelkasten tools): throws the note. */
export async function requireQueryEmbedding(storage: StorageBackend, text: string): Promise<Float32Array> {
  const r = await embedQuery(storage, text);
  if (!r.vec) throw new Error(r.note);
  return r.vec;
}

/** Cheap throughput probe for ETA: embeds `texts` and returns chunks/s. */
export async function measureThroughput(backend: EmbeddingBackend, texts: string[]): Promise<number> {
  if (texts.length === 0) return 0;
  await backend.embed(texts.slice(0, 1)); // warm: model load
  const t0 = performance.now();
  await backend.embed(texts);
  return texts.length / ((performance.now() - t0) / 1000);
}
