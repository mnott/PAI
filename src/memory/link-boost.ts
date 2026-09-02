/**
 * Rank search results by how the corpus links to them, not only by similarity.
 *
 * Why this exists: the store holds 33,709 wikilinks that are *facts* — one note
 * pointing at another, written by a person — alongside 2.4M chunks whose only
 * ranking signal is embedding similarity. Similarity answers "what reads like
 * the query". It cannot answer "which of these is the one the others refer
 * back to", which is usually the note worth reading first.
 *
 * The boost is deliberately query-local: it counts links *between the results
 * themselves*, not global popularity. A note linked by many other notes that
 * also match the query is a hub for that question. A note linked by half the
 * vault is merely popular, which is not the same thing and would flatten every
 * ranking toward the same few index pages.
 *
 * Links cost nothing to maintain — no embedding pass, no model call — so this
 * signal stays correct while the embedding backlog drains, and works for chunks
 * that have no embedding at all.
 */

import type { SearchResult } from "./search.js";

/** A directed link between two note paths, as stored in vault_links. */
export interface LinkEdge {
  sourcePath: string;
  targetPath: string;
}

export interface LinkBoostOptions {
  /**
   * How much the boost may move a result, as a fraction of its current score.
   * 0.25 means the most-linked result gains 25%. Kept modest by default: the
   * link graph is a supporting signal, and a note nobody links to can still be
   * the right answer.
   */
  weight?: number;
}

/**
 * Re-rank results by inbound links *from other results in the same set*.
 *
 * Returns a new array, sorted by the adjusted score. Input is not mutated.
 * Results whose paths carry no inbound links are unchanged, so a corpus with
 * no links at all is a no-op rather than a distortion.
 */
export function applyLinkBoost(
  results: SearchResult[],
  edges: LinkEdge[],
  opts?: LinkBoostOptions,
): SearchResult[] {
  const weight = opts?.weight ?? 0.25;
  if (results.length === 0 || edges.length === 0 || weight === 0) {
    return [...results];
  }

  // Only links whose BOTH ends are in the result set count. An edge pointing
  // out of the set says nothing about the relative rank of results inside it.
  const paths = new Set(results.map((r) => r.path));
  const inbound = new Map<string, number>();
  for (const e of edges) {
    if (e.sourcePath === e.targetPath) continue;      // self-links are noise
    if (!paths.has(e.sourcePath) || !paths.has(e.targetPath)) continue;
    inbound.set(e.targetPath, (inbound.get(e.targetPath) ?? 0) + 1);
  }
  if (inbound.size === 0) return [...results];

  // Normalise against the most-linked result so the boost is bounded by
  // `weight` regardless of corpus size. Without this, a densely linked project
  // would swamp similarity entirely while a sparse one would see no effect.
  const maxInbound = Math.max(...inbound.values());

  return results
    .map((r) => {
      const links = inbound.get(r.path) ?? 0;
      if (links === 0) return { ...r };
      const factor = 1 + weight * (links / maxInbound);
      return { ...r, score: r.score * factor };
    })
    .sort((a, b) => b.score - a.score);
}
