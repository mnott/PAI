/** Memory index command: index one or all projects into the memory store. */

import type { Command } from "commander";
import type { StorageBackend } from "../../../storage/interface.js";
import type { IndexResult } from "../../../memory/indexer-backend.js";
import { indexProjectWithBackend } from "../../../memory/indexer-backend.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { dim, bold, ok, err } from "../../utils.js";
import { PaiClient } from "../../../daemon/ipc-client.js";
import { loadConfig } from "../../../daemon/config.js";
import { runEmbed } from "./embed.js";

/**
 * Index every active project through the StorageBackend. Loops
 * indexProjectWithBackend() per project rather than the sync indexer's
 * indexAll(), since that one still takes a raw registry Database handle.
 */
async function indexAllProjects(
  backend: StorageBackend,
): Promise<{ projects: number; result: IndexResult }> {
  const registry = await getRegistryBackend();
  const projects = await registry.listProjects({ status: "active" });

  const totals: IndexResult = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0 };
  for (const project of projects) {
    const r = await indexProjectWithBackend(backend, project.id, project.root_path, project.claude_notes_dir);
    totals.filesProcessed += r.filesProcessed;
    totals.chunksCreated += r.chunksCreated;
    totals.filesSkipped += r.filesSkipped;
  }
  return { projects: projects.length, result: totals };
}

export function registerIndexCommand(memoryCmd: Command): void {
  memoryCmd
    .command("index [project-slug]")
    .description("Index memory files for one project or all projects")
    .option("--all", "Index all active projects (default when no slug given)")
    .option("--embed", "Also generate embeddings for newly indexed chunks (Phase 2.5)")
    .option("--direct", "Skip daemon IPC and run index directly (for debugging)")
    .action(async (projectSlug: string | undefined, opts: { all?: boolean; embed?: boolean; direct?: boolean }) => {
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
          console.log(dim("Daemon not running. Running direct index..."));
        }
      }

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

        if (!project || project.status !== "active") {
          console.error(err(`Project not found or not active: ${projectSlug}`));
          process.exitCode = 1;
          return;
        }

        console.log(dim(`Indexing ${project.display_name} (${project.slug})...`));
        const result = await indexProjectWithBackend(backend, project.id, project.root_path, project.claude_notes_dir);

        console.log(
          ok(`Done.`) +
          `  ${bold(String(result.filesProcessed))} files indexed` +
          `, ${bold(String(result.chunksCreated))} chunks created` +
          `, ${dim(String(result.filesSkipped) + " skipped (unchanged)")}`,
        );

        if (opts.embed) {
          await runEmbed(backend, project.id, project.slug);
        }

      } else if (opts.all || !projectSlug) {
        console.log(dim("Indexing all active projects..."));

        const { projects, result } = await indexAllProjects(backend);

        console.log(
          ok(`Done.`) +
          `  ${bold(String(projects))} projects` +
          `, ${bold(String(result.filesProcessed))} files indexed` +
          `, ${bold(String(result.chunksCreated))} chunks created` +
          `, ${dim(String(result.filesSkipped) + " skipped (unchanged)")}`,
        );

        if (opts.embed) {
          await runEmbed(backend);
        }
      }
    });
}
