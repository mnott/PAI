/** Barrel: registers all memory sub-commands and re-exports registerMemoryCommands. */

import type { Command } from "commander";
import { registerIndexCommand } from "./index-cmd.js";
import { registerEmbedCommand } from "./embed.js";
import { registerSearchCommand } from "./search.js";
import { registerStatsCommands } from "./stats.js";
import { registerSourcesCommand } from "./sources-cmd.js";

export function registerMemoryCommands(memoryCmd: Command): void {
  registerIndexCommand(memoryCmd);
  registerEmbedCommand(memoryCmd);
  registerSearchCommand(memoryCmd);
  registerStatsCommands(memoryCmd);
  registerSourcesCommand(memoryCmd);
}
