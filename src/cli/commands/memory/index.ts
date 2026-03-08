/** Barrel: registers all memory sub-commands and re-exports registerMemoryCommands. */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { registerIndexCommand } from "./index-cmd.js";
import { registerEmbedCommand } from "./embed.js";
import { registerSearchCommand } from "./search.js";
import { registerStatsCommands } from "./stats.js";

export function registerMemoryCommands(
  memoryCmd: Command,
  getDb: () => Database,
): void {
  registerIndexCommand(memoryCmd, getDb);
  registerEmbedCommand(memoryCmd, getDb);
  registerSearchCommand(memoryCmd, getDb);
  registerStatsCommands(memoryCmd, getDb);
}
