import type { StorageBackend } from "../storage/interface.js";
import {
  deserializeEmbedding,
  generateEmbedding,
  cosineSimilarity,
} from "../memory/embeddings.js";

export interface SurpriseOptions {
  referencePath: string;
  vaultProjectId: number;
  limit?: number;
  minSimilarity?: number;
  minGraphDistance?: number;
}

export interface SurpriseResult {
  path: string;
  title: string | null;
  cosineSimilarity: number;
  graphDistance: number;
  surpriseScore: number;
  sharedSnippet: string;
}

const MAX_CHUNKS = 5000;
const BFS_HOP_CAP = 20;

async function getFileEmbeddings(
  backend: StorageBackend,
  projectId: number,
): Promise<Map<string, { embedding: Float32Array; text: string }>> {
  const rows = await backend.getChunksWithEmbeddings(projectId, MAX_CHUNKS);

  const byPath = new Map<string, { sum: Float32Array; count: number; text: string }>();
  for (const row of rows) {
    const vec = deserializeEmbedding(row.embedding);
    const entry = byPath.get(row.path);
    if (!entry) {
      byPath.set(row.path, { sum: new Float32Array(vec), count: 1, text: row.text });
    } else {
      for (let i = 0; i < vec.length; i++) {
        entry.sum[i] += vec[i];
      }
      entry.count++;
    }
  }

  const result = new Map<string, { embedding: Float32Array; text: string }>();
  for (const [path, { sum, count, text }] of byPath) {
    const avg = new Float32Array(sum.length);
    for (let i = 0; i < sum.length; i++) {
      avg[i] = sum[i] / count;
    }
    result.set(path, { embedding: avg, text });
  }
  return result;
}

async function getReferenceEmbedding(
  backend: StorageBackend,
  projectId: number,
  path: string,
): Promise<{ embedding: Float32Array; found: boolean }> {
  const rows = await backend.getChunksForPath(projectId, path);

  if (rows.length === 0) {
    return { embedding: new Float32Array(0), found: false };
  }

  const embRows = rows.filter(r => r.embedding !== null) as Array<{ text: string; embedding: Buffer }>;
  if (embRows.length === 0) {
    return { embedding: new Float32Array(0), found: false };
  }

  const dim = deserializeEmbedding(embRows[0].embedding).length;
  const sum = new Float32Array(dim);
  for (const row of embRows) {
    const vec = deserializeEmbedding(row.embedding);
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i];
    }
  }
  const avg = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    avg[i] = sum[i] / embRows.length;
  }
  return { embedding: avg, found: true };
}

async function bfsGraphDistance(backend: StorageBackend, source: string, target: string): Promise<number> {
  if (source === target) return 0;

  const visited = new Set<string>([source]);
  const queue: Array<{ path: string; hops: number }> = [{ path: source, hops: 0 }];

  while (queue.length > 0) {
    const { path, hops } = queue.shift()!;
    if (hops >= BFS_HOP_CAP) continue;

    const [forwardLinks, backwardLinks] = await Promise.all([
      backend.getLinksFromSource(path),
      backend.getLinksToTarget(path),
    ]);

    const neighbors: string[] = [
      ...forwardLinks.filter(l => l.targetPath !== null).map(l => l.targetPath as string),
      ...backwardLinks.map(l => l.sourcePath),
    ];

    for (const neighbor of neighbors) {
      if (neighbor === target) return hops + 1;
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ path: neighbor, hops: hops + 1 });
      }
    }
  }

  return Infinity;
}

function getBestChunkText(
  chunkRows: Array<{ text: string; embedding: Buffer | null }>,
  refEmbedding: Float32Array,
): string {
  const rows = chunkRows.filter(r => r.embedding !== null) as Array<{ text: string; embedding: Buffer }>;
  if (rows.length === 0) return "";

  let bestText = rows[0].text;
  let bestSim = -Infinity;

  for (const row of rows) {
    const vec = deserializeEmbedding(row.embedding);
    const sim = cosineSimilarity(refEmbedding, vec);
    if (sim > bestSim) {
      bestSim = sim;
      bestText = row.text;
    }
  }

  return bestText.trim().slice(0, 200);
}

/**
 * Find notes that are semantically similar to a reference note but graph-distant —
 * revealing surprising conceptual connections across unrelated areas of the Zettelkasten.
 */
export async function zettelSurprise(
  backend: StorageBackend,
  opts: SurpriseOptions,
): Promise<SurpriseResult[]> {
  const limit = opts.limit ?? 10;
  const minSimilarity = opts.minSimilarity ?? 0.3;
  const minGraphDistance = opts.minGraphDistance ?? 3;

  let { embedding: refEmbedding, found } = await getReferenceEmbedding(
    backend,
    opts.vaultProjectId,
    opts.referencePath,
  );

  // Fall back to generating an embedding from the file title if no chunks exist
  if (!found) {
    const files = await backend.getVaultFilesByPaths([opts.referencePath]);
    const text = files[0]?.title ?? opts.referencePath;
    refEmbedding = await generateEmbedding(text, true);
  }

  const allFileEmbeddings = await getFileEmbeddings(backend, opts.vaultProjectId);

  // Remove the reference note itself from candidates
  allFileEmbeddings.delete(opts.referencePath);

  // First pass: filter by semantic similarity to avoid BFS on all nodes
  const semanticCandidates: Array<{ path: string; sim: number }> = [];
  for (const [path, { embedding }] of allFileEmbeddings) {
    const sim = cosineSimilarity(refEmbedding, embedding);
    if (sim >= minSimilarity) {
      semanticCandidates.push({ path, sim });
    }
  }

  // Compute graph distances for semantic candidates
  const results: SurpriseResult[] = [];

  for (const { path, sim } of semanticCandidates) {
    const graphDistance = await bfsGraphDistance(backend, opts.referencePath, path);

    const effectiveDistance = isFinite(graphDistance) ? graphDistance : BFS_HOP_CAP;
    if (effectiveDistance < minGraphDistance) continue;

    const files = await backend.getVaultFilesByPaths([path]);
    const chunkRows = await backend.getChunksForPath(opts.vaultProjectId, path, 20);

    const surpriseScore = sim * Math.log2(effectiveDistance + 1);
    const sharedSnippet = getBestChunkText(chunkRows, refEmbedding);

    results.push({
      path,
      title: files[0]?.title ?? null,
      cosineSimilarity: sim,
      graphDistance: isFinite(graphDistance) ? graphDistance : Infinity,
      surpriseScore,
      sharedSnippet,
    });
  }

  results.sort((a, b) => b.surpriseScore - a.surpriseScore);
  return results.slice(0, limit);
}
