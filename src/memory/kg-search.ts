/**
 * kg-search.ts — Graph-completion retrieval (MR1).
 *
 * Implements graphCompletionSearch: a multi-phase retrieval strategy that
 * combines vector search with knowledge-graph neighborhood expansion.
 *
 * Algorithm:
 *   Phase 1: Wide vector search (50 candidates) using queryVec
 *   Phase 2: Extract entity mentions from retrieved chunks (substring match vs kg_entities)
 *   Phase 3: BFS neighborhood expansion in kg_triples (1-2 hops from matched entities)
 *   Phase 4: Re-rank all collected triples against query embedding using cosine similarity
 *
 * The result is a ranked list of KgTriple objects most relevant to the query,
 * augmented with graph-derived context that pure vector search would miss.
 */

import type { Pool } from "pg";
import type { Database } from "better-sqlite3";
import { cosineSimilarity, deserializeEmbedding } from "./embeddings.js";
import type { SearchResult, SearchOptions } from "./search.js";
import type { KgTriple } from "./kg.js";
import { kgQuery } from "./kg.js";
import { listKgEntities } from "./kg-entity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphCompletionResult {
  /** Ranked KG triples relevant to the query */
  triples: Array<KgTriple & { relevanceScore: number }>;
  /** Chunks from the initial wide vector search (Phase 1) */
  seedChunks: SearchResult[];
  /** Entity names that were matched and used for BFS expansion */
  expandedEntities: string[];
}

export interface GraphCompletionOptions {
  /** Number of seed chunks to fetch in Phase 1. Default: 50 */
  seedCount?: number;
  /** BFS hop depth for neighborhood expansion. Default: 1 */
  hops?: number;
  /** Maximum triples to return after re-ranking. Default: 20 */
  maxTriples?: number;
  /** Postgres project_id filter for triples. */
  projectId?: number;
  /** Tenant ID for entity lookup in federation.db. Default: "default" */
  tenantId?: string;
  /** StorageBackend search options to pass to Phase 1 */
  searchOpts?: SearchOptions;
}

// ---------------------------------------------------------------------------
// Phase 2: Entity mention extraction
// ---------------------------------------------------------------------------

/**
 * Find entity names (from the federation.db kg_entities table) that appear
 * as substrings in the given text chunks.
 *
 * Returns a deduplicated list of matching entity names.
 */
function extractEntityMentions(
  federationDb: Database,
  chunks: SearchResult[],
  tenantId = "default"
): string[] {
  // Load all entity names for this tenant (sorted by length desc so longer
  // entity names are matched before substrings)
  const entities = listKgEntities(federationDb, tenantId, undefined, 500);
  if (entities.length === 0) return [];

  const combinedText = chunks.map((c) => c.snippet).join("\n").toLowerCase();
  const matched = new Set<string>();

  for (const entity of entities) {
    if (combinedText.includes(entity.name.toLowerCase())) {
      matched.add(entity.name);
    }
  }

  return Array.from(matched);
}

// ---------------------------------------------------------------------------
// Phase 3: BFS neighborhood expansion
// ---------------------------------------------------------------------------

/**
 * Perform BFS over kg_triples to find neighbors of the given entity names.
 *
 * For each entity name, fetches triples where the entity is the subject
 * or the object (bi-directional expansion). Supports 1 or 2 hop depths.
 *
 * Returns all unique triples found in the BFS expansion.
 */
async function bfsExpand(
  pool: Pool,
  entityNames: string[],
  hops: number,
  projectId?: number
): Promise<KgTriple[]> {
  const seen = new Set<number>(); // triple IDs already included
  const tripleMap = new Map<number, KgTriple>();
  const frontier = new Set(entityNames);

  for (let hop = 0; hop < hops; hop++) {
    const nextFrontier = new Set<string>();

    for (const name of frontier) {
      // Expand as subject
      const asSubject = await kgQuery(pool, {
        subject: name,
        project_id: projectId,
      });

      // Expand as object
      const asObject = await kgQuery(pool, {
        object: name,
        project_id: projectId,
      });

      for (const triple of [...asSubject, ...asObject]) {
        if (!seen.has(triple.id)) {
          seen.add(triple.id);
          tripleMap.set(triple.id, triple);
          // Add neighbors to next frontier for deeper hops
          nextFrontier.add(triple.subject);
          nextFrontier.add(triple.object);
        }
      }
    }

    // Next hop frontier: only new names not already processed
    frontier.clear();
    for (const name of nextFrontier) {
      if (!entityNames.includes(name)) {
        frontier.add(name);
        entityNames.push(name);
      }
    }
  }

  return Array.from(tripleMap.values());
}

// ---------------------------------------------------------------------------
// Phase 4: Re-rank triples against query embedding
// ---------------------------------------------------------------------------

/**
 * Score each triple by cosine similarity to the query embedding.
 *
 * The triple text representation is: "subject predicate object"
 * We embed this on-the-fly using generateEmbedding(), which may use a cache.
 *
 * Returns triples sorted by relevance score descending.
 */
async function rerankTriples(
  triples: KgTriple[],
  queryVec: Float32Array,
  maxTriples: number
): Promise<Array<KgTriple & { relevanceScore: number }>> {
  if (triples.length === 0) return [];

  const { generateEmbedding } = await import("./embeddings.js");

  const scored = await Promise.all(
    triples.map(async (triple) => {
      const text = `${triple.subject} ${triple.predicate} ${triple.object}`;
      try {
        const vec = await generateEmbedding(text, false);
        const score = cosineSimilarity(queryVec, vec);
        return { ...triple, relevanceScore: score };
      } catch {
        return { ...triple, relevanceScore: 0 };
      }
    })
  );

  return scored
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxTriples);
}

// ---------------------------------------------------------------------------
// Main: graphCompletionSearch
// ---------------------------------------------------------------------------

/**
 * Graph-completion retrieval combining vector search with KG neighborhood BFS.
 *
 * @param federationDb  SQLite federation.db (for chunk/entity lookup)
 * @param pool          Postgres connection pool (for kg_triples queries)
 * @param queryVec      Pre-computed embedding for the search query
 * @param opts          Configuration options
 */
export async function graphCompletionSearch(
  federationDb: Database,
  pool: Pool,
  queryVec: Float32Array,
  opts: GraphCompletionOptions = {}
): Promise<GraphCompletionResult> {
  const {
    seedCount = 50,
    hops = 1,
    maxTriples = 20,
    projectId,
    tenantId = "default",
    searchOpts,
  } = opts;

  // Phase 1: Wide vector search over federation.db for seed chunks
  const seedSearchOpts: SearchOptions = {
    ...searchOpts,
    maxResults: seedCount,
    projectIds: projectId != null ? [projectId] : searchOpts?.projectIds,
  };

  let seedChunks: SearchResult[] = [];
  try {
    const { searchMemorySemantic } = await import("./search.js");
    seedChunks = searchMemorySemantic(federationDb, queryVec, seedSearchOpts);
  } catch (e) {
    process.stderr.write(`[kg-search] Phase 1 seed search error: ${e}\n`);
  }

  if (seedChunks.length === 0) {
    return { triples: [], seedChunks: [], expandedEntities: [] };
  }

  // Phase 2: Extract entity mentions from seed chunks
  const expandedEntities = extractEntityMentions(federationDb, seedChunks, tenantId);

  if (expandedEntities.length === 0) {
    // No entities matched — return empty graph results (seed chunks still useful)
    return { triples: [], seedChunks, expandedEntities: [] };
  }

  // Phase 3: BFS neighborhood expansion in kg_triples
  let expandedTriples: KgTriple[] = [];
  try {
    expandedTriples = await bfsExpand(pool, [...expandedEntities], hops, projectId);
  } catch (e) {
    process.stderr.write(`[kg-search] Phase 3 BFS expansion error: ${e}\n`);
  }

  if (expandedTriples.length === 0) {
    return { triples: [], seedChunks, expandedEntities };
  }

  // Phase 4: Re-rank triples against query embedding
  let rankedTriples: Array<KgTriple & { relevanceScore: number }> = [];
  try {
    rankedTriples = await rerankTriples(expandedTriples, queryVec, maxTriples);
  } catch (e) {
    process.stderr.write(`[kg-search] Phase 4 rerank error: ${e}\n`);
    // Fall back to unranked triples
    rankedTriples = expandedTriples.slice(0, maxTriples).map((t) => ({
      ...t,
      relevanceScore: 0,
    }));
  }

  return { triples: rankedTriples, seedChunks, expandedEntities };
}
