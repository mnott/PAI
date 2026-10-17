/**
 * Commander registration for `pai session cleanup`.
 */

import type { Command } from "commander";
import { runCleanup } from "../../../cli2/commands/session-cleanup/cleanup.js";

export function registerSessionCleanupCommand(sessionCmd: Command): void {
  sessionCmd
    .command("cleanup [project-slug]")
    .description(
      "Clean up session notes: delete empties, auto-name unnamed, move into YYYY/MM/ hierarchy, renumber"
    )
    .option("--execute", "Actually perform the cleanup (default is dry-run)")
    .option("--no-renumber", "Skip renumbering sessions after deletions")
    .option("--no-reindex", "Skip triggering memory re-index after moves")
    .action(
      async (
        projectSlug: string | undefined,
        opts: { execute?: boolean; renumber?: boolean; reindex?: boolean }
      ) => {
        await runCleanup(projectSlug, opts);
      }
    );
}
