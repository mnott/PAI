/**
 * MCP tool handler: memory_kg_search
 *
 * Exposes graphCompletionSearch as an MCP tool (MR1 — graph-completion retrieval).
 *
 * Algorithm: wide vector search → entity mention extraction → BFS neighborhood
 * expansion in kg_triples → re-rank triples by cosine similarity to query.
 *
 * Requires:
 *   - federation.db (SQLite) for chunk and entity lookups
 *   - Postgres pool for kg_triples BFS expansion
 *
 * Returns ranked KG triples with relevanceScore, plus seed chunk metadata.
 */

import type { Database } from "better-sqlite3";
import type { Pool } from "pg";
import type { ToolResult } from "./types.js";
import { graphCompletionSearch } from "../../memory/kg-search.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryKgSearchParams {
  /** Free-text query — used to generate embedding for Phase 1 vector search. */
  query: string;
  /** Restrict seed vector search to a specific project ID. Optional. */
  project_id?: number;
  /** Number of seed chunks from Phase 1 vector search. Default: 50 */
  wide_k?: number;
  /** BFS hop depth for KG neighborhood expansion. Default: 1 */
  neighborhood_depth?: number;
  /** Maximum triples to return after Phase 4 re-ranking. Default: 20 */
  top_k?: number;
  /** Tenant ID for entity lookup in federation.db. Default: "default" */
  tenant_id?: string;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Graph-completion search: vector search + KG neighborhood BFS.
 *
 * @param federationDb  SQLite federation.db for chunk/entity operations
 * @param pool          Postgres pool for kg_triples BFS expansion
 * @param params        Tool parameters
 */
export async function toolMemoryKgSearch(
  federationDb: Database,
  pool: Pool,
  params: MemoryKgSearchParams
): Promise<ToolResult> {
  try {
    if (!params.query || typeof params.query !== "string" || params.query.trim() === "") {
      return {
        content: [{ type: "text", text: "memory_kg_search error: query is required" }],
        isError: true,
      };
    }

    const { generateEmbedding } = await import("../../memory/embeddings.js");
    const queryVec = await generateEmbedding(params.query, true);

    const result = await graphCompletionSearch(federationDb, pool, queryVec, {
      seedCount: params.wide_k ?? 50,
      hops: params.neighborhood_depth ?? 1,
      maxTriples: params.top_k ?? 20,
      projectId: params.project_id,
      tenantId: params.tenant_id ?? "default",
    });

    if (result.triples.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No KG triples found for query: "${params.query}"\n` +
              `Seed chunks: ${result.seedChunks.length}, ` +
              `Expanded entities: ${result.expandedEntities.length}`,
          },
        ],
      };
    }

    const tripleLines = result.triples
      .map((t, i) =>
        `[${i + 1}] (score=${t.relevanceScore.toFixed(4)}) ${t.subject} — ${t.predicate} — ${t.object}`
      )
      .join("\n");

    const entityList = result.expandedEntities.slice(0, 10).join(", ");
    const summary = [
      `Found ${result.triples.length} KG triple(s) for "${params.query}"`,
      `Seed chunks: ${result.seedChunks.length}`,
      `Expanded entities (${result.expandedEntities.length}): ${entityList}`,
      "",
      tripleLines,
    ].join("\n");

    return {
      content: [{ type: "text", text: summary }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `memory_kg_search error: ${String(e)}` }],
      isError: true,
    };
  }
}
