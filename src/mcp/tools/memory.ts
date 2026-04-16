/**
 * MCP tool handlers: memory_search, memory_get
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { Database } from "better-sqlite3";
import { populateSlugs, searchMemoryHybrid, touchChunksLastAccessed } from "../../memory/search.js";
import type { StorageBackend } from "../../storage/interface.js";
import type { SearchConfig } from "../../daemon/config.js";
import type { SearchResult } from "../../memory/search.js";
import {
  lookupProjectId,
  type ToolResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tool: memory_search
// ---------------------------------------------------------------------------

export interface MemorySearchParams {
  query: string;
  project?: string;
  all_projects?: boolean;
  sources?: Array<"memory" | "notes">;
  limit?: number;
  mode?: "keyword" | "semantic" | "hybrid";
  /** Rerank results using cross-encoder model for better relevance ordering. */
  rerank?: boolean;
  /** Apply recency boost — score decays by half every N days. 0 = off (default). */
  recencyBoost?: number;
  /** Maximum characters per result snippet. Default 200.
   *  Limit context consumption — MCP results go into Claude's context window. */
  snippetLength?: number;
  /** Output format: "full" (default, includes snippets) or "compact" (IDs + metadata only, ~10x fewer tokens). */
  format?: "full" | "compact";
}

export async function toolMemorySearch(
  registryDb: Database,
  federation: Database | StorageBackend,
  params: MemorySearchParams,
  searchDefaults?: SearchConfig,
): Promise<ToolResult> {
  try {
    const projectIds: number[] | undefined = params.project
      ? (() => {
          const id = lookupProjectId(registryDb, params.project!);
          return id != null ? [id] : [];
        })()
      : undefined;

    if (params.project && (!projectIds || projectIds.length === 0)) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    // NOTE: No indexAll() here — indexing is handled by the daemon scheduler.
    // The daemon ensures the index stays fresh; the search hot path is read-only.

    const mode = params.mode ?? (searchDefaults?.mode ?? "keyword");
    // Limit context consumption — MCP results go into Claude's context window.
    // Default to 5 results and 200-char snippets to keep a single search call
    // within ~1-2K tokens rather than 5K+.
    const snippetLength = params.snippetLength ?? (searchDefaults?.snippetLength ?? 200);
    const searchOpts = {
      projectIds,
      sources: params.sources,
      maxResults: params.limit ?? (searchDefaults?.defaultLimit ?? 5),
    };

    let results;

    // Determine if federation is a StorageBackend or a raw Database
    const isBackend = (x: Database | StorageBackend): x is StorageBackend =>
      "backendType" in x;

    if (isBackend(federation)) {
      // Use the storage backend interface (works for both SQLite and Postgres)
      if (mode === "keyword") {
        results = await federation.searchKeyword(params.query, searchOpts);
      } else if (mode === "semantic" || mode === "hybrid") {
        const { generateEmbedding } = await import("../../memory/embeddings.js");
        const queryEmbedding = await generateEmbedding(params.query, true);

        if (mode === "semantic") {
          results = await federation.searchSemantic(queryEmbedding, searchOpts);
        } else {
          // Hybrid: combine keyword + semantic
          const [kwResults, semResults] = await Promise.all([
            federation.searchKeyword(params.query, { ...searchOpts, maxResults: 50 }),
            federation.searchSemantic(queryEmbedding, { ...searchOpts, maxResults: 50 }),
          ]); // 50 candidates is sufficient for min-max normalization
          // Reuse the existing hybrid scoring logic
          results = combineHybridResults(kwResults, semResults, searchOpts.maxResults ?? 10);
        }
      } else {
        results = await federation.searchKeyword(params.query, searchOpts);
      }
    } else {
      // Legacy path: raw better-sqlite3 Database (for direct MCP server usage)
      const { searchMemory, searchMemorySemantic } = await import("../../memory/search.js");

      if (mode === "keyword") {
        results = searchMemory(federation, params.query, searchOpts);
      } else if (mode === "semantic" || mode === "hybrid") {
        const { generateEmbedding } = await import("../../memory/embeddings.js");
        const queryEmbedding = await generateEmbedding(params.query, true);

        if (mode === "semantic") {
          results = searchMemorySemantic(federation, queryEmbedding, searchOpts);
        } else {
          results = searchMemoryHybrid(
            federation,
            params.query,
            queryEmbedding,
            searchOpts
          );
        }
      } else {
        results = searchMemory(federation, params.query, searchOpts);
      }
    }

    // QW2: Update last_accessed_at for returned chunks (best-effort, non-blocking)
    try {
      const chunkIds = results
        .map((r) => r.chunkId)
        .filter((id): id is string => id != null);
      if (chunkIds.length > 0) {
        // Resolve a raw SQLite Database handle if available
        const rawDb = !isBackend(federation)
          ? federation
          : (federation as { getSqliteDb?: () => Database }).getSqliteDb?.() ?? null;
        if (rawDb) {
          touchChunksLastAccessed(rawDb, chunkIds);
        }
      }
    } catch {
      // non-critical — never block search results
    }

    // Cross-encoder reranking (on by default)
    const shouldRerank = params.rerank ?? (searchDefaults?.rerank ?? true);
    if (shouldRerank && results.length > 0) {
      const { rerankResults } = await import("../../memory/reranker.js");
      results = await rerankResults(params.query, results, {
        topK: searchOpts.maxResults ?? 5,
      });
    }

    // Recency boost (off by default, applied after reranking)
    const recencyDays = params.recencyBoost ?? (searchDefaults?.recencyBoostDays ?? 0);
    if (recencyDays > 0 && results.length > 0) {
      const { applyRecencyBoost } = await import("../../memory/search.js");
      results = applyRecencyBoost(results, recencyDays);
    }

    const withSlugs = populateSlugs(results, registryDb);

    if (withSlugs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results found for query: "${params.query}" (mode: ${mode})`,
          },
        ],
      };
    }

    const rerankLabel = shouldRerank ? " +rerank" : "";
    const useCompact = params.format === "compact";
    const formatted = withSlugs
      .map((r, i) => {
        const slug = r.projectSlug ?? `project:${r.projectId}`;
        const idPart = r.chunkId ? ` id=${r.chunkId}` : "";
        if (useCompact) {
          // Compact format: chunk ID, path, score — pass id to memory_feedback to rate this result
          return `[${i + 1}]${idPart} ${slug} — ${r.path} L${r.startLine}-${r.endLine} score=${r.score.toFixed(3)}`;
        }
        const header = `[${i + 1}]${idPart} ${slug} — ${r.path} (lines ${r.startLine}-${r.endLine}) score=${r.score.toFixed(4)} tier=${r.tier} source=${r.source}`;
        // Truncate snippet to snippetLength — limit context consumption.
        // MCP results go into Claude's context window; keep each result tight.
        const raw = r.snippet.trim();
        const snippet = raw.length > snippetLength
          ? raw.slice(0, snippetLength) + "..."
          : raw;
        return `${header}\n${snippet}`;
      })
      .join(useCompact ? "\n" : "\n\n---\n\n");

    // Query feedback loop: save query + result metadata for future indexing
    try {
      const { saveQueryResult } = await import("../../zettelkasten/query-feedback.js");
      saveQueryResult({
        query: params.query,
        timestamp: Date.now(),
        source: "memory_search",
        sourceSlugs: withSlugs.slice(0, 5).map((r) => r.path),
        answerPreview: withSlugs.slice(0, 3).map((r) => r.snippet.trim().slice(0, 150)).join(" | "),
        resultCount: withSlugs.length,
      });
    } catch {
      // Non-critical — don't fail the search if feedback logging errors
    }

    return {
      content: [
        {
          type: "text",
          text: `Found ${withSlugs.length} result(s) for "${params.query}" (mode: ${mode}${rerankLabel}):\n\n${formatted}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Search error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: memory_get
// ---------------------------------------------------------------------------

export interface MemoryGetParams {
  project: string;
  path: string;
  from?: number;
  lines?: number;
}

export function toolMemoryGet(
  registryDb: Database,
  params: MemoryGetParams
): ToolResult {
  try {
    const projectId = lookupProjectId(registryDb, params.project);
    if (projectId == null) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    const project = registryDb
      .prepare("SELECT root_path FROM projects WHERE id = ?")
      .get(projectId) as { root_path: string } | undefined;

    if (!project) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    const requestedPath = params.path;
    if (requestedPath.includes("..") || isAbsolute(requestedPath)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid path: ${params.path} (must be a relative path within the project root, no ../ allowed)`,
          },
        ],
        isError: true,
      };
    }

    const fullPath = join(project.root_path, requestedPath);
    const resolvedFull = resolve(fullPath);
    const resolvedRoot = resolve(project.root_path);

    if (
      !resolvedFull.startsWith(resolvedRoot + "/") &&
      resolvedFull !== resolvedRoot
    ) {
      return {
        content: [
          { type: "text", text: `Path traversal blocked: ${params.path}` },
        ],
        isError: true,
      };
    }

    if (!existsSync(fullPath)) {
      return {
        content: [
          {
            type: "text",
            text: `File not found: ${requestedPath} (project: ${params.project})`,
          },
        ],
        isError: true,
      };
    }

    const stat = statSync(fullPath);
    if (stat.size > 5 * 1024 * 1024) {
      return {
        content: [
          {
            type: "text",
            text: `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum 5 MB.`,
          },
        ],
      };
    }

    const content = readFileSync(fullPath, "utf8");
    const allLines = content.split("\n");

    const fromLine = (params.from ?? 1) - 1;
    const toLine =
      params.lines != null
        ? Math.min(fromLine + params.lines, allLines.length)
        : allLines.length;

    const selectedLines = allLines.slice(fromLine, toLine);
    const text = selectedLines.join("\n");

    const header =
      params.from != null
        ? `${params.project}/${requestedPath} (lines ${fromLine + 1}-${toLine}):`
        : `${params.project}/${requestedPath}:`;

    return {
      content: [{ type: "text", text: `${header}\n\n${text}` }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Read error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Hybrid search helper (backend-agnostic)
// ---------------------------------------------------------------------------

/**
 * Combine keyword + semantic results using min-max normalized scoring.
 * Mirrors the logic in searchMemoryHybrid() from memory/search.ts,
 * but works on pre-computed result arrays so it works for any backend.
 */
export function combineHybridResults(
  keywordResults: SearchResult[],
  semanticResults: SearchResult[],
  maxResults: number,
  keywordWeight = 0.5,
  semanticWeight = 0.5
): SearchResult[] {
  if (keywordResults.length === 0 && semanticResults.length === 0) return [];

  const keyFor = (r: SearchResult) =>
    `${r.projectId}:${r.path}:${r.startLine}:${r.endLine}`;

  function minMaxNormalize(items: SearchResult[]): Map<string, number> {
    if (items.length === 0) return new Map();
    const min = Math.min(...items.map((r) => r.score));
    const max = Math.max(...items.map((r) => r.score));
    const range = max - min;
    const m = new Map<string, number>();
    for (const r of items) {
      m.set(keyFor(r), range === 0 ? 1 : (r.score - min) / range);
    }
    return m;
  }

  const kwNorm = minMaxNormalize(keywordResults);
  const semNorm = minMaxNormalize(semanticResults);

  const allKeys = new Set<string>([
    ...keywordResults.map(keyFor),
    ...semanticResults.map(keyFor),
  ]);

  const metaMap = new Map<string, SearchResult>();
  for (const r of [...keywordResults, ...semanticResults]) {
    metaMap.set(keyFor(r), r);
  }

  const combined: Array<SearchResult & { combinedScore: number }> = [];
  for (const key of allKeys) {
    const meta = metaMap.get(key)!;
    const kwScore = kwNorm.get(key) ?? 0;
    const semScore = semNorm.get(key) ?? 0;
    const combinedScore = keywordWeight * kwScore + semanticWeight * semScore;
    combined.push({ ...meta, score: combinedScore, combinedScore });
  }

  return combined
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ combinedScore: _unused, ...r }) => r);
}
