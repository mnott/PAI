/** Old commander registration; the logic lives in src/cli2. */
import type { Command } from "commander";
import { runBackup } from "../../cli2/commands/lifecycle/backup.js";
export { oldBackupsDir, backupsDirPath } from "../../cli2/commands/lifecycle/backup.js";

export function registerBackupCommands(program: Command): void {
  program
    .command("backup")
    .description("Backup registry, config, and Postgres database to PAI_HOME/backups/")
    .option("--no-postgres", "Skip the Postgres pg_dump (faster, registry+config only)")
    .action(async (opts: { postgres: boolean }) => {
      await runBackup(opts);
    });
}
