import type { Database } from "better-sqlite3";
import { deserializeEmbedding, cosineSimilarity } from "../memory/embeddings.js";
import { basename } from "node:path";

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

// Stop words to ignore when generating tag/label strings
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "has", "had", "have", "not", "this", "that", "i", "my", "we", "our",
]);

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

function getFileAvgEmbedding(
  db: Database,
  projectId: number,
  path: string,
): Float32Array | null {
  const rows = db
    .prepare(
      `SELECT embedding FROM memory_chunks
       WHERE project_id = ? AND path = ? AND embedding IS NOT NULL`,
    )
    .all(projectId, path) as Array<{ embedding: Buffer }>;

  if (rows.length === 0) return null;

  const first = deserializeEmbedding(rows[0].embedding);
  const sum = new Float32Array(first.length);
  for (const row of rows) {
    const vec = deserializeEmbedding(row.embedding);
    for (let i = 0; i < vec.length; i++) {
      sum[i] += vec[i];
    }
  }
  const avg = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) {
    avg[i] = sum[i] / rows.length;
  }
  return avg;
}

function getAllFileEmbeddings(
  db: Database,
  projectId: number,
): Map<string, Float32Array> {
  const rows = db
    .prepare(
      `SELECT path, embedding FROM memory_chunks
       WHERE project_id = ? AND embedding IS NOT NULL
       ORDER BY path, start_line
       LIMIT ?`,
    )
    .all(projectId, MAX_CHUNKS) as Array<{ path: string; embedding: Buffer }>;

  const byPath = new Map<string, { sum: Float32Array; count: number }>();
  for (const row of rows) {
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

  const result = new Map<string, Float32Array>();
  for (const [path, { sum, count }] of byPath) {
    const avg = new Float32Array(sum.length);
    for (let i = 0; i < sum.length; i++) {
      avg[i] = sum[i] / count;
    }
    result.set(path, avg);
  }
  return result;
}

function getFileTags(db: Database, projectId: number, path: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT text FROM memory_chunks
       WHERE project_id = ? AND path = ?
       ORDER BY start_line
       LIMIT 5`,
    )
    .all(projectId, path) as Array<{ text: string }>;
  return extractTagsFromChunkTexts(rows.map((r) => r.text));
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
  db: Database,
  opts: SuggestOptions,
): Promise<Suggestion[]> {
  const limit = opts.limit ?? 5;
  const excludeLinked = opts.excludeLinked ?? true;

  // Step 1: get current outbound links
  const outboundRows = db
    .prepare(
      `SELECT target_path FROM vault_links
       WHERE source_path = ? AND target_path IS NOT NULL`,
    )
    .all(opts.notePath) as Array<{ target_path: string }>;
  const linkedPaths = new Set(outboundRows.map((r) => r.target_path));

  // Step 2: get source embedding
  const sourceEmbedding = getFileAvgEmbedding(db, opts.vaultProjectId, opts.notePath);

  // Step 3a: get all file-level embeddings for semantic scoring
  const allEmbeddings = getAllFileEmbeddings(db, opts.vaultProjectId);
  allEmbeddings.delete(opts.notePath);

  // Step 3b: get source tags
  const sourceTags = getFileTags(db, opts.vaultProjectId, opts.notePath);

  // Step 3c: compute graph neighborhood (friends-of-friends)
  const friendTargetRows = db
    .prepare(
      `SELECT DISTINCT target_path AS path FROM vault_links
       WHERE source_path IN (
         SELECT target_path FROM vault_links
         WHERE source_path = ? AND target_path IS NOT NULL
       ) AND target_path IS NOT NULL`,
    )
    .all(opts.notePath) as Array<{ path: string }>;

  // For each friend-of-friend, count how many of source's direct friends link to them
  const friendLinkCounts = new Map<string, number>();
  for (const { path } of friendTargetRows) {
    if (path === opts.notePath) continue;
    friendLinkCounts.set(path, (friendLinkCounts.get(path) ?? 0) + 1);
  }
  const maxFriendLinks = Math.max(1, ...friendLinkCounts.values());

  // Get all vault files to enumerate candidates
  const allFiles = db
    .prepare("SELECT vault_path, title FROM vault_files")
    .all() as Array<{ vault_path: string; title: string | null }>;

  const suggestions: Suggestion[] = [];

  for (const { vault_path, title } of allFiles) {
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
      const candidateTags = getFileTags(db, opts.vaultProjectId, vault_path);
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
