import type { Database } from "better-sqlite3";
import { searchMemoryHybrid } from "../memory/search.js";
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
function expandNeighbors(db: Database, paths: Set<string>): string[] {
  if (paths.size === 0) return [];

  const placeholders = Array.from(paths).map(() => "?").join(", ");
  const pathList = Array.from(paths);

  const forward = db
    .prepare(
      `SELECT DISTINCT target_path FROM vault_links WHERE source_path IN (${placeholders}) AND target_path IS NOT NULL`,
    )
    .all(...pathList) as Array<{ target_path: string }>;

  const backward = db
    .prepare(
      `SELECT DISTINCT source_path FROM vault_links WHERE target_path IN (${placeholders})`,
    )
    .all(...pathList) as Array<{ source_path: string }>;

  const neighbors: string[] = [];
  for (const r of forward) neighbors.push(r.target_path);
  for (const r of backward) neighbors.push(r.source_path);
  return neighbors;
}

/**
 * Look up the title for a single vault path.
 * Returns null when the path is not found in vault_files.
 */
function getTitle(db: Database, path: string): string | null {
  const row = db
    .prepare("SELECT title FROM vault_files WHERE vault_path = ?")
    .get(path) as { title: string | null } | undefined;
  return row?.title ?? null;
}

/**
 * Count inbound links for a path from vault_health.
 * Used as a tiebreaker when trimming neighbor-only notes.
 */
function getInboundCount(db: Database, path: string): number {
  const row = db
    .prepare("SELECT inbound_count FROM vault_health WHERE vault_path = ?")
    .get(path) as { inbound_count: number } | undefined;
  return row?.inbound_count ?? 0;
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
  db: Database,
  opts: ConverseOptions,
): Promise<ConverseResult> {
  const depth = Math.max(opts.depth ?? 2, 0);
  const limit = Math.max(opts.limit ?? 15, 1);
  const candidateLimit = 20;

  // ------------------------------------------------------------------
  // 1. Hybrid search: find top candidates via BM25 + semantic similarity
  // ------------------------------------------------------------------
  const queryEmbedding = await generateEmbedding(opts.question, true);

  const searchResults = searchMemoryHybrid(
    db,
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
    const neighbors = expandNeighbors(db, frontier);
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
  //    Search results first (ranked by score), then neighbors by inbound count
  // ------------------------------------------------------------------
  const searchRanked = Array.from(searchHits.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .map(([path, info]) => ({ path, ...info, isSearchResult: true }));

  const neighborPaths = Array.from(allPaths).filter((p) => !searchHits.has(p));

  // Sort neighbors by link popularity (inbound count) so that well-connected
  // notes are preferred when we have budget for them.
  const neighborRanked = neighborPaths
    .map((path) => ({
      path,
      score: 0,
      snippet: "",
      inbound: getInboundCount(db, path),
      isSearchResult: false,
    }))
    .sort((a, b) => b.inbound - a.inbound);

  // Combine: search results fill the budget first, then neighbors
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
  const relevantNotes: ConverseResult["relevantNotes"] = [];

  for (const r of selectedSearchPaths) {
    if (!selectedPaths.has(r.path)) continue;
    relevantNotes.push({
      path: r.path,
      title: getTitle(db, r.path),
      snippet: r.snippet,
      score: r.score,
      domain: extractDomain(r.path),
    });
  }

  for (const r of selectedNeighbors) {
    relevantNotes.push({
      path: r.path,
      title: getTitle(db, r.path),
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
    const placeholders = pathList.map(() => "?").join(", ");

    const edgeRows = db
      .prepare(
        `SELECT source_path, target_path, COUNT(*) AS cnt
         FROM vault_links
         WHERE source_path IN (${placeholders})
           AND target_path IN (${placeholders})
         GROUP BY source_path, target_path`,
      )
      .all(...pathList, ...pathList) as Array<{
        source_path: string;
        target_path: string;
        cnt: number;
      }>;

    for (const row of edgeRows) {
      connections.push({
        fromPath: row.source_path,
        toPath: row.target_path,
        fromDomain: extractDomain(row.source_path),
        toDomain: extractDomain(row.target_path),
        strength: row.cnt,
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
