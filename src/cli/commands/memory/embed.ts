/** Memory embed command: generate embeddings for un-embedded chunks. */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { openFederation } from "../../../memory/db.js";
import { embedChunks } from "../../../memory/indexer.js";
import { dim, bold, ok, err } from "../../utils.js";

// ---------------------------------------------------------------------------
// Shared embed runner (used by both index --embed and embed sub-command)
// ---------------------------------------------------------------------------

export async function runEmbed(
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
// Commander registration
// ---------------------------------------------------------------------------

export function registerEmbedCommand(
  memoryCmd: Command,
  getDb: () => Database,
): void {
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
}
