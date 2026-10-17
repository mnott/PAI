/** Old commander registration; the logic lives in src/cli2. */
import type { Command } from "commander";
import { runRestore } from "../../cli2/commands/lifecycle/restore.js";

export function registerRestoreCommands(program: Command): void {
  program
    .command("restore [backup-path]")
    .description("Restore from a backup directory (created by pai backup)")
    .option("--no-postgres", "Skip restoring the Postgres database")
    .option("--yes", "Skip confirmation prompt (non-interactive)")
    .action(async (backupPath: string | undefined, opts: { postgres: boolean; yes: boolean }) => {
      await runRestore(backupPath, opts);
    });
}
