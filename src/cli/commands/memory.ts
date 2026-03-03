/**
 * CLI commands for the PAI memory engine (Phase 2 / Phase 2.5).
 *
 * Commands:
 *   pai memory index [project-slug]   — index one or all projects
 *   pai memory embed [project-slug]   — generate embeddings for un-embedded chunks
 *   pai memory search <query>         — BM25/semantic/hybrid search across federation.db
 *   pai memory status [project-slug]  — show index stats
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import chalk from "chalk";
import { openFederation } from "../../memory/db.js";
import { indexProject, indexAll, embedChunks } from "../../memory/indexer.js";
import { searchMemory, populateSlugs, type SearchResult } from "../../memory/search.js";
import { renderTable, dim, bold, ok, warn, err, fmtDate } from "../utils.js";
import { PaiClient } from "../../daemon/ipc-client.js";
import { loadConfig } from "../../daemon/config.js";
import { createStorageBackend } from "../../storage/factory.js";

// ---------------------------------------------------------------------------
// Tier colour helper
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
// Registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared embed runner
// ---------------------------------------------------------------------------

async function runEmbed(
  federation: Database,
  projectId?: number,
  projectSlug?: string,
  batchSize = 50,
): Promise<void> {
  const label = projectSlug ? `project ${projectSlug}` : "all projects";
  console.log(dim(`Generating embeddings for ${label} (this may take a while on first run)...`));

  const { chunksEmbedded } = await embedChunks(
    federation,
    projectId,
    batchSize,
    (done, total) => {
      process.stdout.write(`\r  ${done} / ${total} chunks embedded...`);
    },
  );

  process.stdout.write("\r");
  console.log(ok(`Done.`) + `  ${bold(String(chunksEmbedded))} chunks embedded`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMemoryCommands(
  memoryCmd: Command,
  getDb: () => Database,
): void {

  // -------------------------------------------------------------------------
  // pai memory index [project-slug]
  // -------------------------------------------------------------------------

  memoryCmd
    .command("index [project-slug]")
    .description("Index memory files for one project or all projects")
    .option("--all", "Index all active projects (default when no slug given)")
    .option("--embed", "Also generate embeddings for newly indexed chunks (Phase 2.5)")
    .option("--direct", "Skip daemon IPC and run index directly (for debugging)")
    .action(async (projectSlug: string | undefined, opts: { all?: boolean; embed?: boolean; direct?: boolean }) => {
      const registryDb = getDb();

      // If daemon is running and no --direct flag, trigger via IPC (non-blocking)
      if (!opts.direct && !projectSlug) {
        try {
          const config = loadConfig();
          const client = new PaiClient(config.socketPath);
          await client.triggerIndex();
          console.log(ok("Index triggered in daemon.") + dim("  Check daemon logs for progress."));
          console.log(dim("  Run `pai daemon logs` to watch progress."));
          return;
        } catch {
          // Daemon not running — fall through to direct index
          console.log(dim("Daemon not running. Running direct index..."));
        }
      }

      let federation: Database;
      try {
        federation = openFederation();
      } catch (e) {
        console.error(err(`Failed to open federation database: ${e}`));
        process.exit(1);
      }

      if (projectSlug) {
        // Index a single project
        const project = registryDb
          .prepare("SELECT id, slug, display_name, root_path FROM projects WHERE slug = ? AND status = 'active'")
          .get(projectSlug) as
          | { id: number; slug: string; display_name: string; root_path: string }
          | undefined;

        if (!project) {
          console.error(err(`Project not found or not active: ${projectSlug}`));
          process.exit(1);
        }

        console.log(dim(`Indexing ${project.display_name} (${project.slug})...`));
        const result = await indexProject(federation, project.id, project.root_path);

        console.log(
          ok(`Done.`) +
          `  ${bold(String(result.filesProcessed))} files indexed` +
          `, ${bold(String(result.chunksCreated))} chunks created` +
          `, ${dim(String(result.filesSkipped) + " skipped (unchanged)")}`,
        );

        if (opts.embed) {
          await runEmbed(federation, project.id, project.slug);
        }

      } else if (opts.all || !projectSlug) {
        // Index all active projects
        console.log(dim("Indexing all active projects..."));

        const { projects, result } = await indexAll(federation, registryDb);

        console.log(
          ok(`Done.`) +
          `  ${bold(String(projects))} projects` +
          `, ${bold(String(result.filesProcessed))} files indexed` +
          `, ${bold(String(result.chunksCreated))} chunks created` +
          `, ${dim(String(result.filesSkipped) + " skipped (unchanged)")}`,
        );

        if (opts.embed) {
          await runEmbed(federation);
        }
      }
    });

  // -------------------------------------------------------------------------
  // pai memory embed [project-slug]
  // -------------------------------------------------------------------------

  memoryCmd
    .command("embed [project-slug]")
    .description("Generate embeddings for un-embedded chunks (Phase 2.5)")
    .option("--batch-size <n>", "Chunks to embed per batch", "50")
    .action(async (projectSlug: string | undefined, opts: { batchSize?: string }) => {
      const registryDb = getDb();

      let federation: Database;
      try {
        federation = openFederation();
      } catch (e) {
        console.error(err(`Failed to open federation database: ${e}`));
        process.exit(1);
      }

      if (projectSlug) {
        const project = registryDb
          .prepare("SELECT id, slug FROM projects WHERE slug = ?")
          .get(projectSlug) as { id: number; slug: string } | undefined;

        if (!project) {
          console.error(err(`Project not found: ${projectSlug}`));
          process.exit(1);
        }

        await runEmbed(federation, project.id, project.slug, parseInt(opts.batchSize ?? "50", 10));
      } else {
        await runEmbed(federation, undefined, undefined, parseInt(opts.batchSize ?? "50", 10));
      }
    });

  // -------------------------------------------------------------------------
  // pai memory search <query>
  // -------------------------------------------------------------------------

  memoryCmd
    .command("search <query>")
    .description("Search indexed memory (BM25 keyword, semantic, or hybrid)")
    .option("--project <slug>", "Restrict search to a specific project")
    .option("--source <source>", "Restrict to 'memory' or 'notes'")
    .option("--limit <n>", "Maximum results to return", "10")
    .option(
      "--mode <mode>",
      "Search mode: keyword (default), semantic, hybrid",
      "keyword",
    )
    .option(
      "--no-rerank",
      "Skip cross-encoder reranking (reranking is on by default)",
    )
    .option(
      "--recency <days>",
      "Apply recency boost: score halves every N days. 0 = off (default)",
      "0",
    )
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

        const maxResults = parseInt(opts.limit ?? "10", 10);
        const mode = (opts.mode ?? "keyword") as "keyword" | "semantic" | "hybrid";

        // Validate mode
        if (!["keyword", "semantic", "hybrid"].includes(mode)) {
          console.error(err(`Invalid mode: ${mode}. Use keyword, semantic, or hybrid.`));
          process.exit(1);
        }

        // Resolve project slug → ID filter
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
          // Use StorageBackend for semantic/hybrid so queries hit Postgres pgvector
          const config = loadConfig();
          const backend = await createStorageBackend(config);

          try {
            const { generateEmbedding } = await import("../../memory/embeddings.js");

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

                results = combined
                  .sort((a, b) => b.score - a.score)
                  .slice(0, maxResults);
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
          const { rerankResults } = await import("../../memory/reranker.js");
          console.log(dim("Reranking with cross-encoder..."));
          results = await rerankResults(query, results, { topK: maxResults });
        }

        // Recency boost (applied after reranking)
        const recencyDays = parseInt(opts.recency ?? "0", 10);
        if (recencyDays > 0) {
          const { applyRecencyBoost } = await import("../../memory/search.js");
          console.log(dim(`Applying recency boost (half-life: ${recencyDays} days)...`));
          results = applyRecencyBoost(results, recencyDays);
        }

        // Populate project slugs for display
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

          console.log(
            `  ${projectLabel}  ${tierLabel}  ${locationLabel}  ${scoreLabel}`,
          );

          // Display snippet (first 3 lines, trimmed)
          const snippetLines = result.snippet
            .split("\n")
            .slice(0, 3)
            .map((l) => `    ${l}`);
          console.log(snippetLines.join("\n"));
          console.log();
        }
      },
    );

  // -------------------------------------------------------------------------
  // pai memory status [project-slug]
  // -------------------------------------------------------------------------

  memoryCmd
    .command("status [project-slug]")
    .description("Show memory index statistics")
    .action((projectSlug: string | undefined) => {
      const registryDb = getDb();

      let federation: Database;
      try {
        federation = openFederation();
      } catch (e) {
        console.error(err(`Failed to open federation database: ${e}`));
        process.exit(1);
      }

      if (projectSlug) {
        // Single project stats
        const project = registryDb
          .prepare("SELECT id, slug, display_name FROM projects WHERE slug = ?")
          .get(projectSlug) as
          | { id: number; slug: string; display_name: string }
          | undefined;

        if (!project) {
          console.error(err(`Project not found: ${projectSlug}`));
          process.exit(1);
        }

        const fileStats = federation
          .prepare(
            "SELECT COUNT(*) as files FROM memory_files WHERE project_id = ?",
          )
          .get(project.id) as { files: number };

        const chunkStats = federation
          .prepare(
            "SELECT COUNT(*) as chunks FROM memory_chunks WHERE project_id = ?",
          )
          .get(project.id) as { chunks: number };

        const lastUpdate = federation
          .prepare(
            "SELECT MAX(updated_at) as last_at FROM memory_chunks WHERE project_id = ?",
          )
          .get(project.id) as { last_at: number | null };

        const tierBreakdown = federation
          .prepare(
            "SELECT tier, COUNT(*) as n FROM memory_chunks WHERE project_id = ? GROUP BY tier ORDER BY n DESC",
          )
          .all(project.id) as Array<{ tier: string; n: number }>;

        console.log(`\n  ${bold(project.display_name)} ${dim(`(${project.slug})`)}\n`);
        console.log(`  ${bold("Files indexed:")}  ${fileStats.files}`);
        console.log(`  ${bold("Chunks:")}         ${chunkStats.chunks}`);
        console.log(
          `  ${bold("Last indexed:")}   ${lastUpdate.last_at ? fmtDate(lastUpdate.last_at) : dim("never")}`,
        );

        if (tierBreakdown.length > 0) {
          console.log(`\n  ${bold("By tier:")}`);
          for (const row of tierBreakdown) {
            console.log(`    ${tierColor(row.tier).padEnd(20)}  ${row.n} chunks`);
          }
        }
        console.log();

      } else {
        // Global stats
        const globalFiles = federation
          .prepare("SELECT COUNT(*) as n FROM memory_files")
          .get() as { n: number };

        const globalChunks = federation
          .prepare("SELECT COUNT(*) as n FROM memory_chunks")
          .get() as { n: number };

        const lastUpdate = federation
          .prepare("SELECT MAX(updated_at) as last_at FROM memory_chunks")
          .get() as { last_at: number | null };

        const projectStats = federation
          .prepare(
            `SELECT
               mf.project_id,
               COUNT(DISTINCT mf.path) as files,
               COUNT(mc.id) as chunks,
               MAX(mc.updated_at) as last_at
             FROM memory_files mf
             LEFT JOIN memory_chunks mc ON mc.project_id = mf.project_id AND mc.path = mf.path
             GROUP BY mf.project_id
             ORDER BY chunks DESC`,
          )
          .all() as Array<{
            project_id: number;
            files: number;
            chunks: number;
            last_at: number | null;
          }>;

        // Enrich with slugs
        const projectIds = projectStats.map((p) => p.project_id);
        const slugMap = new Map<number, string>();
        if (projectIds.length > 0) {
          const placeholders = projectIds.map(() => "?").join(", ");
          const slugRows = registryDb
            .prepare(
              `SELECT id, slug, display_name FROM projects WHERE id IN (${placeholders})`,
            )
            .all(...projectIds) as Array<{
              id: number;
              slug: string;
              display_name: string;
            }>;
          for (const row of slugRows) {
            slugMap.set(row.id, row.slug);
          }
        }

        console.log(`\n  ${bold("PAI Memory Index — Global Status")}\n`);
        console.log(
          `  ${bold("Total files:")}   ${globalFiles.n}   ${bold("Total chunks:")}  ${globalChunks.n}`,
        );
        console.log(
          `  ${bold("Last indexed:")}  ${lastUpdate.last_at ? fmtDate(lastUpdate.last_at) : dim("never")}`,
        );

        if (projectStats.length > 0) {
          console.log();
          const rows = projectStats.map((p) => [
            chalk.cyan(slugMap.get(p.project_id) ?? String(p.project_id)),
            String(p.files),
            String(p.chunks),
            p.last_at ? fmtDate(p.last_at) : dim("never"),
          ]);
          console.log(
            renderTable(["Project", "Files", "Chunks", "Last Indexed"], rows),
          );
        } else {
          console.log(dim("\n  No projects indexed yet. Run `pai memory index --all` to start."));
        }
        console.log();
      }
    });
}
