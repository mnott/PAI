/** Step 7b: TypeScript (.mjs) hooks installation to ~/.claude/Hooks/. */

import { existsSync, readFileSync, readdirSync, copyFileSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { c, line, section, type Rl, promptYesNo, getDistHooksDir } from "../utils.js";

export async function stepTsHooks(rl: Rl): Promise<boolean> {
  section("Step 7b: TypeScript Hooks Installation");
  line();
  line("  PAI ships 14 compiled TypeScript hooks (.mjs) that fire on session events,");
  line("  tool use, and context compaction to capture context and update notes.");
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
  let copiedCount = 0;
  let skippedCount = 0;
  let cleanedCount = 0;

  for (const filename of allFiles) {
    const src = join(distHooksDir, filename);
    const dest = join(hooksTarget, filename);
    const srcContent = readFileSync(src, "utf-8");

    if (existsSync(dest)) {
      const destContent = readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        console.log(c.dim(`  Unchanged: ${filename}`));
        skippedCount++;
        const staleTsPath = join(hooksTarget, filename.replace(/\.mjs$/, ".ts"));
        if (existsSync(staleTsPath)) {
          unlinkSync(staleTsPath);
          console.log(c.ok(`Cleaned up stale: ${filename.replace(/\.mjs$/, ".ts")}`));
          cleanedCount++;
        }
        continue;
      }
    }

    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    console.log(c.ok(`Installed: ${filename}`));
    copiedCount++;

    const staleTsPath = join(hooksTarget, filename.replace(/\.mjs$/, ".ts"));
    if (existsSync(staleTsPath)) {
      unlinkSync(staleTsPath);
      console.log(c.ok(`Cleaned up stale: ${filename.replace(/\.mjs$/, ".ts")}`));
      cleanedCount++;
    }
  }

  line();
  if (copiedCount > 0 || cleanedCount > 0) {
    const parts = [];
    if (copiedCount > 0) parts.push(`${copiedCount} hook(s) installed`);
    if (skippedCount > 0) parts.push(`${skippedCount} unchanged`);
    if (cleanedCount > 0) parts.push(`${cleanedCount} stale .ts file(s) cleaned up`);
    console.log(c.ok(parts.join(", ") + "."));
  } else {
    console.log(c.dim(`  All ${skippedCount} hook(s) already up-to-date.`));
  }

  return copiedCount > 0 || cleanedCount > 0;
}
