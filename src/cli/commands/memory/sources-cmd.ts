/** `pai memory sources` — what the indexer has taken in. */

import { err, dim } from "../../lib/utils.js";
import { CliError } from "../../define.js";

export async function memorySourcesCmd(
  args: { limit?: string },
  opts: { limit?: number }
): Promise<number> {
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
    return 1;
  }

  try {
    await cmdMemorySources(backend, {
      limit: Math.max(1, opts.limit ?? 8),
    });
    return 0;
  } finally {
    await backend.close?.().catch?.(() => {});
  }
}
