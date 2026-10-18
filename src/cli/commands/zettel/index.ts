/** Barrel: registers all zettel sub-commands and exports registerZettelCommands. */

import type { Command } from "commander";
import { registerSuggestCommand } from "./suggest.js";
import { registerConverseCommand } from "./converse.js";
import { registerThemesCommand } from "./themes.js";

export function registerZettelCommands(parent: Command): void {
  registerSuggestCommand(parent);
  registerConverseCommand(parent);
  registerThemesCommand(parent);
}
