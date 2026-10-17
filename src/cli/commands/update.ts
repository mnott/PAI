import type { Command } from "commander";
import { runUpdate } from "../../cli2/commands/lifecycle/update.js";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Update PAI from GitHub (git pull + rebuild + daemon restart). Preserves local customizations.",
    )
    .action(async () => {
      await runUpdate();
    });
}
