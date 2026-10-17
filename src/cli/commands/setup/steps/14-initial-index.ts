/** Step 12: Initial index — optionally starts the daemon and runs registry scan. */

import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { c, line, section, type Rl, promptYesNo } from "../utils.js";
import { stepDirectories } from "./13-directories.js";

export async function stepInitialIndex(rl: Rl): Promise<void> {
  section("Step 12: Initial Index");
  line();
  line("  Indexing scans your registered projects and builds the search index.");
  line("  The daemon runs indexing automatically every 5 minutes once started.");
  line();

  const willScan = (stepDirectories as { _runScan?: boolean })._runScan;

  if (willScan) {
    const startDaemon = await promptYesNo(rl, "Start the PAI daemon now? (enables background indexing)", true);

    if (startDaemon) {
      line();
      console.log(c.dim("  Starting daemon..."));

      try {
        const result = spawnSync("pai", ["daemon", "serve", "--background"], { stdio: "pipe", timeout: 10000 });
        if (result.status === 0) {
          console.log(c.ok("Daemon started in background."));
        } else {
          console.log(c.warn("Could not start daemon. Run manually: pai daemon serve"));
        }
      } catch {
        console.log(c.warn("Could not start daemon. Run manually: pai daemon serve"));
      }

      line();
      console.log(c.dim("  Running registry scan to detect projects..."));

      try {
        const result = spawnSync("pai", ["registry", "scan"], { stdio: "inherit", timeout: 30000 });
        if (result.status !== 0) {
          console.log(c.warn("Registry scan encountered issues. Run `pai registry scan` manually."));
        }
      } catch {
        console.log(c.warn("Could not run registry scan. Run manually: pai registry scan"));
      }
    } else {
      console.log(chalk.dim("  Start the daemon later: pai daemon serve"));
      console.log(chalk.dim("  Scan projects later: pai registry scan"));
    }
  } else {
    console.log(chalk.dim("  Register projects with: pai project add <path>"));
    console.log(chalk.dim("  Then index them with: pai memory index --all"));
    console.log(chalk.dim("  Or start the daemon: pai daemon serve"));
  }
}
