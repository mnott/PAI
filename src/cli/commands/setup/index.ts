import type { Command } from "commander";
import chalk from "chalk";
import { setupOptions } from "../../../cli2/commands/setup/utils.js";
import { runSetup } from "../../../cli2/commands/setup/index.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .alias("install")
    .description(
      "Setup wizard — configure storage, embeddings, agent config, and indexing (--yes for unattended)",
    )
    .option("-y, --yes", "Unattended: take every default, read no input")
    .option("--storage <backend>", "Storage backend: sqlite | postgres (default under --yes: sqlite unless local Postgres answers)")
    .action(async (opts: { yes?: boolean; storage?: string }) => {
      if (opts.storage && opts.storage !== "sqlite" && opts.storage !== "postgres") {
        console.error(`pai setup: --storage must be sqlite or postgres, got "${opts.storage}"`);
        process.exitCode = 1;
        return;
      }
      setupOptions.yes = opts.yes === true;
      setupOptions.storage = opts.storage as "sqlite" | "postgres" | undefined;
      try {
        await runSetup();
      } catch (e) {
        console.error(chalk.red(`pai setup: ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
      }
    });
}
