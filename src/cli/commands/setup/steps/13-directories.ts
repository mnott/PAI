/** Step 11: Directory scanning configuration and registry scan prompt. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { line, section, type Rl, promptYesNo } from "../utils.js";

export async function stepDirectories(rl: Rl): Promise<void> {
  section("Step 11: Directories to Index");
  line();
  line("  PAI indexes files in your registered projects. You can register projects");
  line("  individually with `pai project add <path>`, or let the registry scanner");
  line("  discover them automatically with `pai registry scan`.");
  line();

  const defaults = [
    join(homedir(), "Projects"),
    join(homedir(), "Documents"),
    join(homedir(), "dev"),
  ].filter(existsSync);

  if (defaults.length > 0) {
    line("  These directories exist on your system:");
    for (const d of defaults) {
      console.log(chalk.dim(`    ${d}`));
    }
    line();
  }

  const runScan = await promptYesNo(rl, "Run `pai registry scan` to auto-detect projects after setup?", false);

  if (runScan) {
    line();
    console.log(chalk.dim("  Registry scan will run after setup completes."));
  } else {
    console.log(chalk.dim("  Add projects manually: pai project add <path>"));
    console.log(chalk.dim("  Or discover them later: pai registry scan"));
  }

  (stepDirectories as { _runScan?: boolean })._runScan = runScan;
}
