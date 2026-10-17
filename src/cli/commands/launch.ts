import type { Command } from "commander";
import { runLaunch, type LaunchCliOpts } from "../../cli2/commands/lifecycle/launch.js";

export function registerLaunchCommand(program: Command): void {
  program
    .command("launch")
    .description(
      "Start the Claude Code harness on any provider/model from workers.yaml.\n" +
        "No args, in a terminal: pick from a numbered table. --list (or piped/non-\n" +
        "interactive output): print the table and exit.\n" +
        "--provider <name> [--model <model>]: start directly, no prompt.\n" +
        "A running claude process cannot switch provider — this always starts a NEW\n" +
        "session in the current terminal. Claude Code's own /model command only shows\n" +
        "the CURRENT endpoint's models; `pai launch --list` (or the /providers skill)\n" +
        "shows every provider configured here.\n" +
        "Extra arguments after the options are passed to claude verbatim, e.g.\n" +
        "`pai launch --provider glm -- --resume <id>`.\n" +
        "The `glm`/`kimi` shell shims are thin aliases of `pai launch --provider <name>`."
    )
    .option("--provider <name>", "Provider to start on (default: prompt from the table)")
    .option("--model <model>", "Model id for that provider (default: the provider's default model)")
    .option("--list", "Print the provider/model table and exit")
    .option("--current", "With --list, also detect and mark this session's own provider/model")
    .option("--dry-run", "Print the resolved command and environment (key masked); do not exec")
    .allowUnknownOption(true)
    .argument("[args...]", "extra claude arguments, e.g. --resume <id>")
    .action(async (args: string[], opts: LaunchCliOpts) => {
      await runLaunch(args, opts);
    });
}
