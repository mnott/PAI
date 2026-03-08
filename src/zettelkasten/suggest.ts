import type { StorageBackend } from "../storage/interface.js";
import { deserializeEmbedding, cosineSimilarity } from "../memory/embeddings.js";
import { basename } from "node:path";
import { STOP_WORDS } from "../utils/stop-words.js";

export interface SuggestOptions {
  notePath: string;
  vaultProjectId: number;
  limit?: number;
  excludeLinked?: boolean;
}

export interface Suggestion {
  path: string;
  title: string | null;
  score: number;
  semanticScore: number;
  tagScore: number;
  neighborScore: number;
  reason: string;
  suggestedWikilink: string;
}

const MAX_CHUNKS = 5000;
const SEMANTIC_WEIGHT = 0.5;
const TAG_WEIGHT = 0.2;
const NEIGHBOR_WEIGHT = 0.3;

// STOP_WORDS imported from utils/stop-words.ts

function extractTagsFromChunkTexts(texts: string[]): Set<string> {
  const tags = new Set<string>();
  for (const text of texts) {
    // Match YAML frontmatter tags block: "tags:\n  - tag1\n  - tag2"
    const match = text.match(/^tags:\s*\n((?:[ \t]*-[ \t]*.+\n?)*)/m);
    if (!match) continue;
    const block = match[1];
    const lines = block.split("\n");
    for (const line of lines) {
      const tagMatch = line.match(/^[ \t]*-[ \t]*(.+)/);
      if (tagMatch) {
        const tag = tagMatch[1].trim().toLowerCase();
        if (tag) tags.add(tag);
      }
    }
  }
  return tags;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const tag of a) {
    if (b.has(tag)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildReason(
  semanticScore: number,
  tagScore: number,
  neighborScore: number,
  neighborCount: number,
): string {
  const signals: Array<{ label: string; value: number }> = [
    { label: `Semantically similar (${semanticScore.toFixed(2)})`, value: semanticScore * SEMANTIC_WEIGHT },
    { label: `Shared tags (${tagScore.toFixed(2)} Jaccard)`, value: tagScore * TAG_WEIGHT },
    { label: `Linked by ${neighborCount} mutual connection${neighborCount !== 1 ? "s" : ""}`, value: neighborScore * NEIGHBOR_WEIGHT },
  ];
  signals.sort((a, b) => b.value - a.value);
  return signals[0].label;
}

function suggestedWikilink(vaultPath: string): string {
  const base = basename(vaultPath);
  const name = base.endsWith(".md") ? base.slice(0, -3) : base;
  return `[[${name}]]`;
}

/**
 * Proactively find notes worth linking to a given note, combining semantic similarity,
 * shared tags, and graph-neighborhood signals into a ranked list of suggestions.
 */
export async function zettelSuggest(
  backend: StorageBackend,
  opts: SuggestOptions,
): Promise<Suggestion[]> {
  const limit = opts.limit ?? 5;
  const excludeLinked = opts.excludeLinked ?? true;

  // Step 1: get current outbound links
  const outboundLinks = await backend.getLinksFromSource(opts.notePath);
  const linkedPaths = new Set(outboundLinks.filter(l => l.targetPath !== null).map(l => l.targetPath as string));

  // Step 2a: get all file-level embeddings for semantic scoring
  const chunkRows = await backend.getChunksWithEmbeddings(opts.vaultProjectId, MAX_CHUNKS);

  const byPath = new Map<string, { sum: Float32Array; count: number }>();
  for (const row of chunkRows) {
    const vec = deserializeEmbedding(row.embedding);
    const entry = byPath.get(row.path);
    if (!entry) {
      byPath.set(row.path, { sum: new Float32Array(vec), count: 1 });
    } else {
      for (let i = 0; i < vec.length; i++) {
        entry.sum[i] += vec[i];
      }
      entry.count++;
    }
  }

  const allEmbeddings = new Map<string, Float32Array>();
  for (const [path, { sum, count }] of byPath) {
    const avg = new Float32Array(sum.length);
    for (let i = 0; i < sum.length; i++) {
      avg[i] = sum[i] / count;
    }
    allEmbeddings.set(path, avg);
  }
  allEmbeddings.delete(opts.notePath);

  // Step 2b: get source embedding
  const sourceEmbedding = allEmbeddings.get(opts.notePath) ?? null;

  // Step 2c: get source tags
  const sourceChunkTexts = await backend.getChunksForPath(opts.vaultProjectId, opts.notePath, 5);
  const sourceTags = extractTagsFromChunkTexts(sourceChunkTexts.map(r => r.text));

  // Step 2d: compute graph neighborhood (friends-of-friends)
  const directLinks = await backend.getLinksFromSource(opts.notePath);
  const directTargets = directLinks.filter(l => l.targetPath !== null).map(l => l.targetPath as string);

  const friendLinkCounts = new Map<string, number>();
  for (const target of directTargets) {
    const friendLinks = await backend.getLinksFromSource(target);
    for (const link of friendLinks) {
      if (link.targetPath && link.targetPath !== opts.notePath) {
        friendLinkCounts.set(link.targetPath, (friendLinkCounts.get(link.targetPath) ?? 0) + 1);
      }
    }
  }
  const maxFriendLinks = Math.max(1, ...friendLinkCounts.values());

  // Get all vault files to enumerate candidates
  const allFiles = await backend.getAllVaultFiles();

  const suggestions: Suggestion[] = [];

  for (const fileRow of allFiles) {
    const vault_path = fileRow.vaultPath;
    const title = fileRow.title;

    if (vault_path === opts.notePath) continue;
    if (excludeLinked && linkedPaths.has(vault_path)) continue;

    // Semantic score
    let semanticScore = 0;
    if (sourceEmbedding) {
      const candidateEmbedding = allEmbeddings.get(vault_path);
      if (candidateEmbedding) {
        semanticScore = Math.max(0, cosineSimilarity(sourceEmbedding, candidateEmbedding));
      }
    }

    // Tag score (only compute if candidate might have chunks)
    let tagScore = 0;
    if (allEmbeddings.has(vault_path)) {
      const candidateChunkTexts = await backend.getChunksForPath(opts.vaultProjectId, vault_path, 5);
      const candidateTags = extractTagsFromChunkTexts(candidateChunkTexts.map(r => r.text));
      tagScore = jaccardSimilarity(sourceTags, candidateTags);
    }

    // Neighbor score
    const friendCount = friendLinkCounts.get(vault_path) ?? 0;
    const neighborScore = friendCount / maxFriendLinks;

    const score =
      SEMANTIC_WEIGHT * semanticScore +
      TAG_WEIGHT * tagScore +
      NEIGHBOR_WEIGHT * neighborScore;

    // Only include if there is at least some signal
    if (score <= 0) continue;

    const reason = buildReason(semanticScore, tagScore, neighborScore, friendCount);

    suggestions.push({
      path: vault_path,
      title,
      score,
      semanticScore,
      tagScore,
      neighborScore,
      reason,
      suggestedWikilink: suggestedWikilink(vault_path),
    });
  }

  suggestions.sort((a, b) => b.score - a.score);
  return suggestions.slice(0, limit);
}
