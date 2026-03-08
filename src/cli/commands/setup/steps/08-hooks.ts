/** Step 7: Shell lifecycle hooks installation (pre-compact, session-stop, statusline). */

import { existsSync, readFileSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { c, line, section, type Rl, promptYesNo, getHooksDir, getStatuslineScript, getTabColorScript } from "../utils.js";

export async function stepHooks(rl: Rl): Promise<boolean> {
  section("Step 7: Lifecycle Hooks");
  line();
  line("  PAI hooks fire on session stop and context compaction to save state,");
  line("  update notes, and display live statusline information.");
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

  function installFile(src: string, dest: string, label: string): void {
    if (!existsSync(src)) {
      console.log(c.warn(`  Source not found: ${src}`));
      return;
    }

    const srcContent = readFileSync(src, "utf-8");

    if (existsSync(dest)) {
      const destContent = readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        console.log(c.dim(`  Unchanged: ${label}`));
        return;
      }
    }

    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    console.log(c.ok(`Installed: ${label}`));
    anyInstalled = true;
  }

  line();
  installFile(join(hooksDir, "pre-compact.sh"), join(hooksTarget, "pai-pre-compact.sh"), "pai-pre-compact.sh");
  installFile(join(hooksDir, "session-stop.sh"), join(hooksTarget, "pai-session-stop.sh"), "pai-session-stop.sh");

  if (statuslineSrc) {
    installFile(statuslineSrc, join(claudeDir, "statusline-command.sh"), "statusline-command.sh");
  } else {
    console.log(c.warn("  statusline-command.sh not found — skipping statusline."));
  }

  if (tabColorSrc) {
    installFile(tabColorSrc, join(claudeDir, "tab-color-command.sh"), "tab-color-command.sh");
  } else {
    console.log(c.warn("  tab-color-command.sh not found — skipping tab color."));
  }

  return anyInstalled;
}
