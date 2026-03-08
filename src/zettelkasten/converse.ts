import type { StorageBackend } from "../storage/interface.js";
import type { SearchResult } from "../memory/search.js";
import { generateEmbedding } from "../memory/embeddings.js";

export interface ConverseOptions {
  /** The user's question or topic to explore. */
  question: string;
  /** project_id for vault chunks in memory_chunks. */
  vaultProjectId: number;
  /** Graph expansion depth. Default 2. */
  depth?: number;
  /** Maximum number of relevant notes to return. Default 15. */
  limit?: number;
}

export interface ConverseConnection {
  fromPath: string;
  toPath: string;
  /** Top-level folder of fromPath. */
  fromDomain: string;
  /** Top-level folder of toPath. */
  toDomain: string;
  /** Link count between these two notes (can be > 1). */
  strength: number;
}

export interface ConverseResult {
  relevantNotes: Array<{
    path: string;
    title: string | null;
    snippet: string;
    score: number;
    domain: string;
  }>;
  /** Cross-domain connections found among the selected notes. */
  connections: ConverseConnection[];
  /** Unique domains involved across all selected notes. */
  domains: string[];
  /** AI-ready prompt combining notes + connections for insight generation. */
  synthesisPrompt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the top-level folder from a vault path (first path segment). */
function extractDomain(vaultPath: string): string {
  const slash = vaultPath.indexOf("/");
  return slash === -1 ? vaultPath : vaultPath.slice(0, slash);
}

/**
 * Expand one level of graph neighbors for a set of paths.
 * Returns all outbound and inbound neighbor paths (excluding already-visited).
 */
async function expandNeighbors(backend: StorageBackend, paths: Set<string>): Promise<string[]> {
  if (paths.size === 0) return [];
  const pathList = Array.from(paths);

  const [forwardLinks, backwardLinks] = await Promise.all([
    backend.getVaultLinksFromPaths(pathList),
    Promise.all(pathList.map(p => backend.getLinksToTarget(p))),
  ]);

  const neighbors: string[] = [];
  for (const link of forwardLinks) {
    if (link.targetPath) neighbors.push(link.targetPath);
  }
  for (const linkList of backwardLinks) {
    for (const link of linkList) {
      neighbors.push(link.sourcePath);
    }
  }
  return neighbors;
}

/**
 * Hybrid search combining keyword + semantic results using the StorageBackend.
 */
async function hybridSearch(
  backend: StorageBackend,
  query: string,
  queryEmbedding: Float32Array,
  opts: { projectIds?: number[]; maxResults?: number },
): Promise<SearchResult[]> {
  const maxResults = opts.maxResults ?? 10;
  const kw = 0.5;
  const sw = 0.5;

  const [keywordResults, semanticResults] = await Promise.all([
    backend.searchKeyword(query, { ...opts, maxResults: 50 }),
    backend.searchSemantic(queryEmbedding, { ...opts, maxResults: 50 }),
  ]);

  if (keywordResults.length === 0 && semanticResults.length === 0) return [];

  const keyFor = (r: SearchResult) =>
    `${r.projectId}:${r.path}:${r.startLine}:${r.endLine}`;

  function minMaxNormalize(scores: number[]): number[] {
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    if (range === 0) return scores.map(() => 1.0);
    return scores.map(s => (s - min) / range);
  }

  const kwNorm = minMaxNormalize(keywordResults.map(r => r.score));
  const semNorm = minMaxNormalize(semanticResults.map(r => r.score));

  const combined = new Map<string, SearchResult & { combinedScore: number }>();

  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const k = keyFor(r);
    combined.set(k, { ...r, combinedScore: kw * kwNorm[i] });
  }

  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const k = keyFor(r);
    const existing = combined.get(k);
    if (existing) {
      existing.combinedScore += sw * semNorm[i];
    } else {
      combined.set(k, { ...r, combinedScore: sw * semNorm[i] });
    }
  }

  const sorted = Array.from(combined.values())
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, maxResults);

  return sorted.map(r => ({ ...r, score: r.combinedScore }));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Let the vault "talk back" — find notes relevant to a question, expand
 * through the link graph, identify cross-domain connections, and return a
 * structured result including a synthesis prompt for an AI to generate insights.
 */
export async function zettelConverse(
  backend: StorageBackend,
  opts: ConverseOptions,
): Promise<ConverseResult> {
  const depth = Math.max(opts.depth ?? 2, 0);
  const limit = Math.max(opts.limit ?? 15, 1);
  const candidateLimit = 20;

  // ------------------------------------------------------------------
  // 1. Hybrid search: find top candidates via BM25 + semantic similarity
  // ------------------------------------------------------------------
  const queryEmbedding = await generateEmbedding(opts.question, true);

  const searchResults = await hybridSearch(
    backend,
    opts.question,
    queryEmbedding,
    {
      projectIds: [opts.vaultProjectId],
      maxResults: candidateLimit,
    },
  );

  // Map of path -> best score + snippet from search results
  const searchHits = new Map<string, { score: number; snippet: string }>();
  for (const r of searchResults) {
    const existing = searchHits.get(r.path);
    if (!existing || r.score > existing.score) {
      searchHits.set(r.path, { score: r.score, snippet: r.snippet });
    }
  }

  // ------------------------------------------------------------------
  // 2. Graph expansion: BFS from each search result up to `depth` levels
  // ------------------------------------------------------------------
  const allPaths = new Set<string>(searchHits.keys());
  let frontier = new Set<string>(searchHits.keys());

  for (let d = 0; d < depth; d++) {
    const neighbors = await expandNeighbors(backend, frontier);
    const newFrontier = new Set<string>();
    for (const n of neighbors) {
      if (!allPaths.has(n)) {
        allPaths.add(n);
        newFrontier.add(n);
      }
    }
    if (newFrontier.size === 0) break;
    frontier = newFrontier;
  }

  // ------------------------------------------------------------------
  // 3. Deduplicate + trim to limit
  // ------------------------------------------------------------------
  const searchRanked = Array.from(searchHits.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .map(([path, info]) => ({ path, ...info, isSearchResult: true }));

  const neighborPaths = Array.from(allPaths).filter((p) => !searchHits.has(p));

  // Fetch health data for neighbor ranking
  const neighborHealthRows = await Promise.all(
    neighborPaths.map(p => backend.getVaultHealth(p))
  );
  const neighborRanked = neighborPaths
    .map((path, idx) => ({
      path,
      score: 0,
      snippet: "",
      inbound: neighborHealthRows[idx]?.inboundCount ?? 0,
      isSearchResult: false,
    }))
    .sort((a, b) => b.inbound - a.inbound);

  const budgetForNeighbors = Math.max(limit - searchRanked.length, 0);
  const selectedNeighbors = neighborRanked.slice(0, budgetForNeighbors);

  const selectedSearchPaths = searchRanked.slice(0, limit);
  const selectedPaths = new Set<string>([
    ...selectedSearchPaths.map((r) => r.path),
    ...selectedNeighbors.map((r) => r.path),
  ]);

  // ------------------------------------------------------------------
  // 4. Build relevantNotes with titles + domains
  // ------------------------------------------------------------------

  // Fetch titles in bulk
  const allSelectedPaths = Array.from(selectedPaths);
  const fileRows = await backend.getVaultFilesByPaths(allSelectedPaths);
  const titleMap = new Map<string, string | null>(fileRows.map(f => [f.vaultPath, f.title]));

  const relevantNotes: ConverseResult["relevantNotes"] = [];

  for (const r of selectedSearchPaths) {
    if (!selectedPaths.has(r.path)) continue;
    relevantNotes.push({
      path: r.path,
      title: titleMap.get(r.path) ?? null,
      snippet: r.snippet,
      score: r.score,
      domain: extractDomain(r.path),
    });
  }

  for (const r of selectedNeighbors) {
    relevantNotes.push({
      path: r.path,
      title: titleMap.get(r.path) ?? null,
      snippet: r.snippet,
      score: 0,
      domain: extractDomain(r.path),
    });
  }

  // ------------------------------------------------------------------
  // 5. Find connections between the selected notes
  // ------------------------------------------------------------------
  let connections: ConverseConnection[] = [];

  if (selectedPaths.size > 0) {
    const pathList = Array.from(selectedPaths);
    const pathSet = new Set(pathList);

    // Get all outbound links from the selected paths
    const linkRows = await backend.getVaultLinksFromPaths(pathList);

    // Count links between selected paths
    const edgeCounts = new Map<string, number>();
    for (const link of linkRows) {
      if (link.targetPath && pathSet.has(link.targetPath)) {
        const key = `${link.sourcePath}|||${link.targetPath}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }

    for (const [key, cnt] of edgeCounts) {
      const [sourcePath, targetPath] = key.split("|||");
      connections.push({
        fromPath: sourcePath,
        toPath: targetPath,
        fromDomain: extractDomain(sourcePath),
        toDomain: extractDomain(targetPath),
        strength: cnt,
      });
    }
  }

  // ------------------------------------------------------------------
  // 6. Domains + cross-domain filter
  // ------------------------------------------------------------------
  const domainSet = new Set<string>(relevantNotes.map((n) => n.domain));
  const domains = Array.from(domainSet).sort();

  const crossDomainConnections = connections.filter(
    (c) => c.fromDomain !== c.toDomain,
  );

  // ------------------------------------------------------------------
  // 7. Build synthesis prompt
  // ------------------------------------------------------------------
  const notesSummary = relevantNotes
    .map((n, i) => {
      const title = n.title ? `"${n.title}"` : "(untitled)";
      const domain = n.domain;
      const scoreLabel = n.score > 0 ? ` [relevance: ${n.score.toFixed(3)}]` : " [context]";
      const snippet = n.snippet.trim().slice(0, 300);
      return `${i + 1}. [${domain}] ${title}${scoreLabel}\n   Path: ${n.path}\n   "${snippet}"`;
    })
    .join("\n\n");

  const connectionSummary =
    crossDomainConnections.length > 0
      ? crossDomainConnections
          .map(
            (c) =>
              `- "${c.fromPath}" (${c.fromDomain}) → "${c.toPath}" (${c.toDomain}) [strength: ${c.strength}]`,
          )
          .join("\n")
      : "(no cross-domain connections found)";

  const domainList = domains.join(", ");

  const synthesisPrompt = `You are a Zettelkasten research assistant. The vault has surfaced the following notes in response to this question:

QUESTION: ${opts.question}

---

RELEVANT NOTES (${relevantNotes.length} notes across ${domains.length} domain(s): ${domainList}):

${notesSummary}

---

CROSS-DOMAIN CONNECTIONS (links bridging different knowledge areas):

${connectionSummary}

---

SYNTHESIS TASK:

Based on these notes and the connections between them, please:

1. Identify the key insights that emerge in direct response to the question.
2. Highlight any unexpected connections between notes from different domains (${domainList}).
3. Point out tensions, contradictions, or open questions the vault raises but does not resolve.
4. Suggest what is notably absent — what the vault does NOT yet contain that would strengthen the understanding of this topic.
5. Propose 2-3 new notes that would meaningfully extend this knowledge cluster.

Think like a scholar who has deeply internalized these ideas and is now synthesizing them for the first time.`;

  return {
    relevantNotes,
    connections: crossDomainConnections,
    domains,
    synthesisPrompt,
  };
}
