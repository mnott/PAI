/** Step 7: Shell lifecycle hooks installation (pre-compact, session-stop, statusline). */

import {
  existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync,
  copyFileSync, chmodSync, mkdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { c, line, section, type Rl, promptYesNo, getHooksDir, getStatuslineScript, getTabColorScript } from "../utils.js";

const useSymlinks = platform() !== "win32";

export async function stepHooks(rl: Rl): Promise<boolean> {
  section("Step 7: Lifecycle Hooks");
  line();
  line("  PAI hooks fire on session stop and context compaction to save state,");
  line("  update notes, and display live statusline information.");
  if (useSymlinks) {
    line("  Files are symlinked so they auto-update when PAI is rebuilt.");
  } else {
    line("  Files are copied (Windows — re-run setup after PAI updates).");
  }
  line();

  const install = await promptYesNo(rl, "Install PAI lifecycle hooks (session stop, pre-compact, statusline)?", true);
  if (!install) {
    console.log(c.dim("  Skipping hook installation."));
    return false;
  }

  const hooksDir = getHooksDir();
  const statuslineSrc = getStatuslineScript();
  const tabColorSrc = getTabColorScript();

  const claudeDir = join(homedir(), ".claude");
  const hooksTarget = join(claudeDir, "Hooks");

  if (!existsSync(hooksTarget)) {
    mkdirSync(hooksTarget, { recursive: true });
  }

  let anyInstalled = false;

  function installLink(src: string, dest: string, label: string): void {
    if (!existsSync(src)) {
      console.log(c.warn(`  Source not found: ${src}`));
      return;
    }

    const absSrc = resolve(src);

    // Check existing target
    if (existsSync(dest) || (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink?.())) {
      try {
        const stat = lstatSync(dest);
        if (stat.isSymbolicLink()) {
          if (resolve(readlinkSync(dest)) === absSrc) {
            console.log(c.dim(`  Current: ${label}`));
            return;
          }
          // Stale symlink — replace
          unlinkSync(dest);
        } else if (stat.isFile()) {
          // Old copy — replace with symlink
          unlinkSync(dest);
        } else {
          return; // Don't touch directories
        }
      } catch {
        // lstatSync failed — target doesn't exist, proceed
      }
    }

    if (useSymlinks) {
      symlinkSync(absSrc, dest);
    } else {
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
    }
    const verb = useSymlinks ? "Linked" : "Installed";
    console.log(c.ok(`${verb}: ${label}`));
    anyInstalled = true;
  }

  line();
  installLink(join(hooksDir, "pre-compact.sh"), join(hooksTarget, "pai-pre-compact.sh"), "pai-pre-compact.sh");
  installLink(join(hooksDir, "session-stop.sh"), join(hooksTarget, "pai-session-stop.sh"), "pai-session-stop.sh");

  if (statuslineSrc) {
    installLink(statuslineSrc, join(claudeDir, "statusline-command.sh"), "statusline-command.sh");
  } else {
    console.log(c.warn("  statusline-command.sh not found — skipping statusline."));
  }

  if (tabColorSrc) {
    installLink(tabColorSrc, join(claudeDir, "tab-color-command.sh"), "tab-color-command.sh");
  } else {
    console.log(c.warn("  tab-color-command.sh not found — skipping tab color."));
  }

  return anyInstalled;
}
