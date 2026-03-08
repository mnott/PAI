/** Memory index command: index one or all projects into the memory store. */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { openFederation } from "../../../memory/db.js";
import { indexProject, indexAll } from "../../../memory/indexer.js";
import { dim, bold, ok, err } from "../../utils.js";
import { PaiClient } from "../../../daemon/ipc-client.js";
import { loadConfig } from "../../../daemon/config.js";
import { runEmbed } from "./embed.js";

export function registerIndexCommand(
  memoryCmd: Command,
  getDb: () => Database,
): void {
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
}
