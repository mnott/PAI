/** Step 12: PAI daemon installation (launchd plist on macOS, systemd user unit on Linux). */

import { existsSync } from "node:fs";
import { platform } from "node:os";
import { spawnSync } from "node:child_process";
import { daemonServiceFilePath, daemonServiceName } from "../../../impl/daemon.js";
import { c, line, section, type Rl, promptYesNo } from "../utils.js";

export async function stepDaemon(rl: Rl): Promise<boolean> {
  section("Step 12: Daemon Install");
  line();
  line("  The PAI daemon indexes your projects every 5 minutes in the background.");
  line();

  const linux = platform() === "linux";
  if (linux && !existsSync("/run/systemd/system")) {
    console.log(c.dim("  systemd is not running here (container?). Skipping service install; start the daemon with: pai daemon serve"));
    return false;
  }

  const plistPath = daemonServiceFilePath(linux ? "linux" : "darwin");
  const unit = linux ? "systemd user unit" : "launchd plist";
  const exists = existsSync(plistPath);

  if (exists) {
    console.log(c.dim(`  PAI daemon ${unit} already installed.`));
    line();

    const reinstall = await promptYesNo(rl, `Reinstall the PAI daemon ${unit}?`, false, "daemon");
    if (!reinstall) {
      console.log(c.dim("  Keeping existing daemon installation."));
      return false;
    }
  } else {
    const install = await promptYesNo(rl, "Install the PAI daemon to run automatically at login?", true, "daemon");
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

  console.log(c.ok(`Daemon installed as ${daemonServiceName()}.`));
  return true;
}
