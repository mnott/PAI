/** Memory search command: BM25/semantic/hybrid search across the memory store. */

import chalk from "chalk";
import { applyRecencyBoost, combineHybridResults, populateSlugs, type SearchResult } from "../../../memory/search.js";
import { dim, bold, ok, warn, err } from "../../lib/utils.js";
import { loadConfig } from "../../../daemon/config.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierColor(tier: string): string {
  switch (tier) {
    case "evergreen": return chalk.green(tier);
    case "daily":     return chalk.yellow(tier);
    case "topic":     return chalk.blue(tier);
    case "session":   return chalk.dim(tier);
    default:          return tier;
  }
}

// ---------------------------------------------------------------------------
// Command function
// ---------------------------------------------------------------------------

export async function memorySearchCmd(
  query: string,
  opts: {
    project?: string;
    source?: string;
    limit?: string;
    mode?: string;
    rerank?: boolean;
    recency?: string;
  },
): Promise<number> {
  const config = loadConfig();
  const searchConfig = config.search;

  const maxResults = parseInt(opts.limit ?? String(searchConfig.defaultLimit), 10);
  const mode = (opts.mode ?? searchConfig.mode) as "keyword" | "semantic" | "hybrid";

  if (!["keyword", "semantic", "hybrid"].includes(mode)) {
    console.error(err(`Invalid mode: ${mode}. Use keyword, semantic, or hybrid.`));
    process.exitCode = 1;
    return 1;
  }

  let projectIds: number[] | undefined;
  if (opts.project) {
    const registry = await getRegistryBackend();
    const project = await registry.getProjectBySlug(opts.project);

    if (!project) {
      console.error(warn(`Project not found: ${opts.project} — searching all projects`));
    } else {
      projectIds = [project.id];
    }
  }

  const sources = opts.source ? [opts.source] : undefined;
  const searchOpts = { projectIds, sources, maxResults };

  // getStorageBackend() returns the process-wide shared backend, closed
  // once at process exit (src/storage/factory.ts's beforeExit hook) —
  // this command must not close it itself.
  const backend = await getStorageBackend();
  let results: SearchResult[];

  if (mode === "keyword") {
    results = await backend.searchKeyword(query, searchOpts);

  } else {
    const { embedQuery } = await import("../../../memory/embedding-gate.js");

    console.log(dim("Generating query embedding..."));
    const q = await embedQuery(backend, query);
    const queryEmbedding = q.vec;

    if (!queryEmbedding) {
      console.log(dim(`  ${q.note}`));
      results = await backend.searchKeyword(query, searchOpts);
    } else if (mode === "semantic") {
      results = await backend.searchSemantic(queryEmbedding, searchOpts);
    } else {
      // Hybrid: combine keyword (BM25) and semantic results with min-max normalization
      const [keywordResults, semanticResults] = await Promise.all([
        backend.searchKeyword(query, { ...searchOpts, maxResults: 500 }),
        backend.searchSemantic(queryEmbedding, { ...searchOpts, maxResults: 500 }),
      ]);

      results = combineHybridResults(keywordResults, semanticResults, maxResults);
    }
  }

  if (!results || results.length === 0) {
    console.log(dim(`No results found for: "${query}" (mode: ${mode})`));
    return 0;
  }

  // Cross-encoder reranking (on by default, skip with --no-rerank)
  if (opts.rerank !== false) {
    const { rerankResults } = await import("../../../memory/reranker.js");
    console.log(dim("Reranking with cross-encoder..."));
    results = await rerankResults(query, results, { topK: maxResults });
  }

  // Recency boost (applied after reranking)
  const recencyDays = parseInt(opts.recency ?? String(searchConfig.recencyBoostDays), 10);
  if (recencyDays > 0) {
    console.log(dim(`Applying recency boost (half-life: ${recencyDays} days)...`));
    results = applyRecencyBoost(results, recencyDays);
  }

  const withSlugs = results.length === 0 ? results : await populateSlugs(results, await getRegistryBackend());
  const rerankLabel = opts.rerank !== false ? " +rerank" : "";
  const modeLabel = mode !== "keyword" ? ` [${mode}${rerankLabel}]` : (opts.rerank !== false ? ` [rerank]` : "");

  console.log(
    `\n  ${bold(`Search results for: "${query}"`)}${modeLabel}  ${dim(`(${withSlugs.length} found)`)}\n`,
  );

  for (const result of withSlugs) {
    const projectLabel = result.projectSlug
      ? chalk.cyan(result.projectSlug)
      : chalk.cyan(String(result.projectId));

    const tierLabel = tierColor(result.tier);
    const scoreLabel = dim(`score: ${result.score.toFixed(4)}`);
    const locationLabel = dim(`${result.path}:${result.startLine}-${result.endLine}`);

    console.log(`  ${projectLabel}  ${tierLabel}  ${locationLabel}  ${scoreLabel}`);

    const snippetLines = result.snippet
      .split("\n")
      .slice(0, 3)
      .map((l) => `    ${l}`);
    console.log(snippetLines.join("\n"));
    console.log();
  }

  return 0;
}
