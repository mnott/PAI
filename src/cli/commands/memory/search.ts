/** Memory search command: BM25/semantic/hybrid search across federation.db. */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import chalk from "chalk";
import { openFederation } from "../../../memory/db.js";
import { searchMemory, populateSlugs, type SearchResult } from "../../../memory/search.js";
import { dim, bold, ok, warn, err } from "../../utils.js";
import { loadConfig } from "../../../daemon/config.js";
import { createStorageBackend } from "../../../storage/factory.js";

// ---------------------------------------------------------------------------
// Helper
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
// Commander registration
// ---------------------------------------------------------------------------

export function registerSearchCommand(
  memoryCmd: Command,
  getDb: () => Database,
): void {
  memoryCmd
    .command("search <query>")
    .description("Search indexed memory (BM25 keyword, semantic, or hybrid)")
    .option("--project <slug>", "Restrict search to a specific project")
    .option("--source <source>", "Restrict to 'memory' or 'notes'")
    .option("--limit <n>", "Maximum results to return")
    .option("--mode <mode>", "Search mode: keyword (default), semantic, hybrid")
    .option("--no-rerank", "Skip cross-encoder reranking (reranking is on by default)")
    .option("--recency <days>", "Apply recency boost: score halves every N days. 0 = off")
    .action(
      async (
        query: string,
        opts: { project?: string; source?: string; limit?: string; mode?: string; rerank: boolean; recency?: string },
      ) => {
        const registryDb = getDb();

        let federation: Database;
        try {
          federation = openFederation();
        } catch (e) {
          console.error(err(`Failed to open federation database: ${e}`));
          process.exit(1);
        }

        const config = loadConfig();
        const searchConfig = config.search;

        const maxResults = parseInt(opts.limit ?? String(searchConfig.defaultLimit), 10);
        const mode = (opts.mode ?? searchConfig.mode) as "keyword" | "semantic" | "hybrid";

        if (!["keyword", "semantic", "hybrid"].includes(mode)) {
          console.error(err(`Invalid mode: ${mode}. Use keyword, semantic, or hybrid.`));
          process.exit(1);
        }

        let projectIds: number[] | undefined;
        if (opts.project) {
          const project = registryDb
            .prepare("SELECT id FROM projects WHERE slug = ?")
            .get(opts.project) as { id: number } | undefined;

          if (!project) {
            console.error(warn(`Project not found: ${opts.project} — searching all projects`));
          } else {
            projectIds = [project.id];
          }
        }

        const sources = opts.source ? [opts.source] : undefined;
        const searchOpts = { projectIds, sources, maxResults };

        let results: SearchResult[];

        if (mode === "keyword") {
          results = searchMemory(federation, query, searchOpts);

        } else if (mode === "semantic" || mode === "hybrid") {
          const backend = await createStorageBackend(config);

          try {
            const { generateEmbedding } = await import("../../../memory/embeddings.js");

            console.log(dim("Generating query embedding..."));
            const queryEmbedding = await generateEmbedding(query, true);

            if (mode === "semantic") {
              results = await backend.searchSemantic(queryEmbedding, searchOpts);
            } else {
              // Hybrid: combine keyword (BM25) and semantic results with min-max normalization
              const [keywordResults, semanticResults] = await Promise.all([
                backend.searchKeyword(query, { ...searchOpts, maxResults: 500 }),
                backend.searchSemantic(queryEmbedding, { ...searchOpts, maxResults: 500 }),
              ]);

              if (keywordResults.length === 0 && semanticResults.length === 0) {
                results = [];
              } else {
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

                const combined: SearchResult[] = [];
                for (const key of allKeys) {
                  const meta = metaMap.get(key)!;
                  const combinedScore = 0.5 * (kwNorm.get(key) ?? 0) + 0.5 * (semNorm.get(key) ?? 0);
                  combined.push({ ...meta, score: combinedScore });
                }

                results = combined.sort((a, b) => b.score - a.score).slice(0, maxResults);
              }
            }
          } finally {
            await backend.close();
          }
        } else {
          results = [];
        }

        if (!results || results.length === 0) {
          console.log(dim(`No results found for: "${query}" (mode: ${mode})`));
          return;
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
          const { applyRecencyBoost } = await import("../../../memory/search.js");
          console.log(dim(`Applying recency boost (half-life: ${recencyDays} days)...`));
          results = applyRecencyBoost(results, recencyDays);
        }

        const withSlugs = populateSlugs(results, registryDb);
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
      },
    );
}
