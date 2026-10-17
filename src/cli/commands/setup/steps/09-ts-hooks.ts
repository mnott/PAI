/** Step 7b: TypeScript (.mjs) hooks installation to ~/.claude/Hooks/. */

import {
  existsSync, readdirSync, lstatSync, readlinkSync,
  symlinkSync, unlinkSync, copyFileSync, chmodSync, mkdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { c, line, section, type Rl, promptYesNo, getDistHooksDir } from "../utils.js";

const useSymlinks = platform() !== "win32";

export async function stepTsHooks(rl: Rl): Promise<boolean> {
  section("Step 7b: TypeScript Hooks Installation");
  line();
  line("  PAI ships compiled TypeScript hooks (.mjs) that fire on session events,");
  line("  tool use, and context compaction to capture context and update notes.");
  if (useSymlinks) {
    line("  Files are symlinked so they auto-update when PAI is rebuilt.");
  } else {
    line("  Files are copied (Windows — re-run setup after PAI updates).");
  }
  line();

  const install = await promptYesNo(rl, "Install PAI TypeScript hooks to ~/.claude/Hooks/?", true);
  if (!install) {
    console.log(c.dim("  Skipping TypeScript hooks installation."));
    return false;
  }

  const distHooksDir = getDistHooksDir();

  if (!existsSync(distHooksDir)) {
    console.log(c.warn(`  dist/hooks/ directory not found at: ${distHooksDir}`));
    console.log(c.dim("  Build the package first: bun run build"));
    return false;
  }

  const claudeDir = join(homedir(), ".claude");
  const hooksTarget = join(claudeDir, "Hooks");

  if (!existsSync(hooksTarget)) {
    mkdirSync(hooksTarget, { recursive: true });
  }

  let allFiles: string[];
  try {
    allFiles = readdirSync(distHooksDir).filter((f) => f.endsWith(".mjs"));
  } catch (e) {
    console.log(c.warn(`  Could not read dist/hooks/: ${e}`));
    return false;
  }

  if (allFiles.length === 0) {
    console.log(c.warn("  No .mjs files found in dist/hooks/. Build first: bun run build"));
    return false;
  }

  line();
  let linkedCount = 0;
  let skippedCount = 0;
  let cleanedCount = 0;

  for (const filename of allFiles) {
    const src = resolve(join(distHooksDir, filename));
    const dest = join(hooksTarget, filename);

    // Check existing target
    let needsLink = true;
    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink?.()) {
      try {
        const stat = lstatSync(dest);
        if (stat.isSymbolicLink()) {
          if (resolve(readlinkSync(dest)) === src) {
            console.log(c.dim(`  Current: ${filename}`));
            skippedCount++;
            needsLink = false;
          } else {
            unlinkSync(dest); // Stale symlink
          }
        } else if (stat.isFile()) {
          unlinkSync(dest); // Old copy — replace with symlink
        }
      } catch {
        // lstatSync failed — target doesn't exist
      }
    }

    if (needsLink) {
      if (useSymlinks) {
        symlinkSync(src, dest);
      } else {
        copyFileSync(src, dest);
        chmodSync(dest, 0o755);
      }
      const verb = useSymlinks ? "Linked" : "Installed";
      console.log(c.ok(`${verb}: ${filename}`));
      linkedCount++;
    }

    // Clean up stale .ts files from pre-build era
    const staleTsPath = join(hooksTarget, filename.replace(/\.mjs$/, ".ts"));
    if (existsSync(staleTsPath)) {
      unlinkSync(staleTsPath);
      console.log(c.ok(`Cleaned up stale: ${filename.replace(/\.mjs$/, ".ts")}`));
      cleanedCount++;
    }
  }

  line();
  if (linkedCount > 0 || cleanedCount > 0) {
    const parts = [];
    const verb = useSymlinks ? "linked" : "installed";
    if (linkedCount > 0) parts.push(`${linkedCount} hook(s) ${verb}`);
    if (skippedCount > 0) parts.push(`${skippedCount} current`);
    if (cleanedCount > 0) parts.push(`${cleanedCount} stale .ts file(s) cleaned up`);
    console.log(c.ok(parts.join(", ") + "."));
  } else {
    console.log(c.dim(`  All ${skippedCount} hook(s) already current.`));
  }

  return linkedCount > 0 || cleanedCount > 0;
}
