/** Memory embed command: generate embeddings for un-embedded chunks. */

import type { Command } from "commander";
import type { StorageBackend } from "../../../storage/interface.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { dim, bold, ok, err } from "../../utils.js";

// ---------------------------------------------------------------------------
// Shared embed runner (used by both index --embed and embed sub-command)
// ---------------------------------------------------------------------------

/** Rows fetched per DB round-trip. Keeps memory flat regardless of backlog size. */
const DEFAULT_PAGE_SIZE = 500;

export async function runEmbed(
  backend: StorageBackend,
  projectId?: number,
  projectSlug?: string,
  batchSize = 50,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<void> {
  const label = projectSlug ? `project ${projectSlug}` : "all projects";
  console.log(dim(`Generating embeddings for ${label} (this may take a while on first run)...`));

  const { generateEmbeddings, serializeEmbedding } = await import("../../../memory/embeddings.js");

  // Estimate, not an exact unembedded count: cheap (one row) vs. scanning the
  // whole backlog just to size a progress bar.
  const { chunks: totalEstimate } =
    projectId !== undefined ? await backend.getProjectStats(projectId) : await backend.getStats();

  let done = 0;
  let after: { projectId: number; id: string } | null = null;

  while (true) {
    const page = await backend.getUnembeddedChunkIds(projectId, pageSize, after);
    if (page.length === 0) break;

    for (let i = 0; i < page.length; i += batchSize) {
      const batch = page.slice(i, i + batchSize);
      const vecs = await generateEmbeddings(batch.map((r) => r.text));
      await Promise.all(batch.map((row, j) => backend.updateEmbedding(row.id, serializeEmbedding(vecs[j]))));
      done += batch.length;
      process.stdout.write(`\r  ${done} / ~${totalEstimate} chunks embedded...`);
    }

    const last = page[page.length - 1];
    after = { projectId: last.project_id, id: last.id };
  }

  process.stdout.write("\r");
  console.log(ok(`Done.`) + `  ${bold(String(done))} chunks embedded`);
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerEmbedCommand(memoryCmd: Command): void {
  memoryCmd
    .command("embed [project-slug]")
    .description("Generate embeddings for un-embedded chunks (Phase 2.5)")
    .option("--batch-size <n>", "Chunks to embed per batch", "50")
    .action(async (projectSlug: string | undefined, opts: { batchSize?: string }) => {
      let backend: StorageBackend;
      try {
        backend = await getStorageBackend();
      } catch (e) {
        console.error(err(`Failed to open storage backend: ${e}`));
        process.exitCode = 1;
        return;
      }

      if (projectSlug) {
        const registry = await getRegistryBackend();
        const project = await registry.getProjectBySlug(projectSlug);

        if (!project) {
          console.error(err(`Project not found: ${projectSlug}`));
          process.exitCode = 1;
          return;
        }

        await runEmbed(backend, project.id, project.slug, parseInt(opts.batchSize ?? "50", 10));
      } else {
        await runEmbed(backend, undefined, undefined, parseInt(opts.batchSize ?? "50", 10));
      }
    });
}
