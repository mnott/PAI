/** Step 9: PAI daemon installation via launchd plist. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { c, line, section, type Rl, promptYesNo } from "../utils.js";

export async function stepDaemon(rl: Rl): Promise<boolean> {
  section("Step 9: Daemon Install");
  line();
  line("  The PAI daemon indexes your projects every 5 minutes in the background.");
  line();

  const plistPath = join(homedir(), "Library", "LaunchAgents", "com.pai.pai-daemon.plist");
  const exists = existsSync(plistPath);

  if (exists) {
    console.log(c.dim("  PAI daemon plist already installed."));
    line();

    const reinstall = await promptYesNo(rl, "Reinstall the PAI daemon launchd plist?", false);
    if (!reinstall) {
      console.log(c.dim("  Keeping existing daemon installation."));
      return false;
    }
  } else {
    const install = await promptYesNo(rl, "Install the PAI daemon to run automatically at login?", true);
    if (!install) {
      console.log(c.dim("  Skipping daemon install. Run manually: pai daemon install"));
      return false;
    }
  }

  line();
  const result = spawnSync("pai", ["daemon", "install"], { stdio: "inherit" });

  if (result.status !== 0) {
    console.log(c.warn("  Daemon install failed. Run manually: pai daemon install"));
    return false;
  }

  console.log(c.ok("Daemon installed as com.pai.pai-daemon."));
  return true;
}
