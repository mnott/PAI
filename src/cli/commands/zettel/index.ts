/** Barrel: registers all zettel sub-commands and exports registerZettelCommands. */

import type { Command } from "commander";
import { registerExploreCommand } from "./explore.js";
import { registerHealthCommand } from "./health.js";
import { registerSurpriseCommand } from "./surprise.js";
import { registerSuggestCommand } from "./suggest.js";
import { registerConverseCommand } from "./converse.js";
import { registerThemesCommand } from "./themes.js";

export function registerZettelCommands(parent: Command): void {
  registerExploreCommand(parent);
  registerHealthCommand(parent);
  registerSurpriseCommand(parent);
  registerSuggestCommand(parent);
  registerConverseCommand(parent);
  registerThemesCommand(parent);
}
