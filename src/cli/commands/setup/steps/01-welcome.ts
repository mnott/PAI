/** Step 1: Welcome banner displayed at the start of the setup wizard. */

import chalk from "chalk";
import { c, line } from "../utils.js";

export function stepWelcome(): void {
  line();
  line(chalk.bold.cyan("  ╔════════════════════════════════════════╗"));
  line(chalk.bold.cyan("  ║      PAI Knowledge OS — Setup Wizard   ║"));
  line(chalk.bold.cyan("  ╚════════════════════════════════════════╝"));
  line();
  line("  PAI is a personal knowledge system that indexes your files, generates");
  line("  semantic embeddings for intelligent search, and stores everything in a");
  line("  local database so you can search your knowledge base with natural language.");
  line();
  line(c.dim("  This wizard will guide you through the initial configuration."));
  line(c.dim("  Press Ctrl+C at any time to cancel."));
}
