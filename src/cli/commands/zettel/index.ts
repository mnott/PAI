/** Barrel: registers all zettel sub-commands and exports registerZettelCommands. */

import type { Command } from "commander";
import { registerSuggestCommand } from "./suggest.js";

export function registerZettelCommands(parent: Command): void {
  registerSuggestCommand(parent);
}
