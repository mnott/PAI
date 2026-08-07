/** Registers `pai memory sources` — what the indexer has taken in. */

import type { Command } from "commander";
import { err, dim } from "../../utils.js";

export function registerSourcesCommand(memoryCmd: Command): void {
  memoryCmd
    .command("sources")
    .description(
      "Show what the indexer has taken in: composition by source, which roots\n" +
        "content enters from, the heaviest single files, and how many chunks are\n" +
        "rewritten per day (which distinguishes a finite backlog from a treadmill)."
    )
    .option("--limit <n>", "Rows per section (default 8)", "8")
    .action(async (opts: { limit?: string }) => {
      // Reads whichever backend is configured — unlike `memory status`, which
      // reads the SQLite federation file directly and therefore has nothing to
      // say when the live index lives in Postgres.
      const { createStorageBackend } = await import("../../../storage/factory.js");
      const { loadConfig } = await import("../../../daemon/config.js");
      const { cmdMemorySources } = await import("./sources.js");

      let backend;
      try {
        backend = await createStorageBackend(loadConfig());
      } catch (e) {
        console.error(err(`Cannot reach the storage backend.`));
        console.error(dim(`  ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
        return;
      }

      try {
        await cmdMemorySources(backend, {
          limit: Math.max(1, parseInt(opts.limit ?? "8", 10) || 8),
        });
      } finally {
        await backend.close?.().catch?.(() => {});
      }
    });
}
