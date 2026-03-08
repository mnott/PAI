/**
 * Step 7: Install PAI MCP skill stubs to ~/.claude/skills/.
 *
 * Each PAI MCP prompt has a SKILL.md stub generated at build time
 * (dist/skills/<Name>/SKILL.md). This step symlinks (macOS/Linux) or
 * copies (Windows) them into Claude Code's skill discovery directory.
 *
 * Skills MUST live at ~/.claude/skills/<Name>/SKILL.md (top level),
 * NOT under a user/ subdirectory — Claude Code only scans one level deep.
 *
 * Symlinks keep the stubs in sync — rebuilding PAI updates them automatically.
 * Existing non-symlink directories with the same name are never overwritten.
 */

import {
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  copyFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { c, line, section, type Rl, promptYesNo, getDistDir } from "../utils.js";

export async function stepSkillStubs(rl: Rl): Promise<boolean> {
  section("Step 7: MCP Skill Stubs");
  line();
  line("  PAI MCP prompts need SKILL.md stubs so Claude Code can discover them.");
  line("  Stubs are symlinked from dist/skills/ — rebuilding PAI keeps them in sync.");
  line();

  const distSkills = join(getDistDir(), "skills");

  if (!existsSync(distSkills)) {
    console.log(c.warn("dist/skills/ not found — run `bun run build` first."));
    return false;
  }

  const skillNames = readdirSync(distSkills).filter((name) => {
    const p = join(distSkills, name);
    return existsSync(join(p, "SKILL.md"));
  });

  if (skillNames.length === 0) {
    console.log(c.warn("No skill stubs found in dist/skills/."));
    return false;
  }

  console.log(c.dim(`  Found ${skillNames.length} skill stubs to install.`));
  line();

  const install = await promptYesNo(
    rl,
    `Symlink ${skillNames.length} PAI skill stubs to ~/.claude/skills/?`,
    true,
  );
  if (!install) {
    console.log(c.dim("  Skipping skill stub installation."));
    return false;
  }

  const targetBase = join(homedir(), ".claude", "skills");
  mkdirSync(targetBase, { recursive: true });

  // Clean up stale symlinks from old user/ location
  const oldUserBase = join(targetBase, "user");
  if (existsSync(oldUserBase)) {
    for (const name of skillNames) {
      const oldTarget = join(oldUserBase, name);
      if (existsSync(oldTarget) && lstatSync(oldTarget).isSymbolicLink()) {
        unlinkSync(oldTarget);
      }
    }
  }

  const useSymlinks = platform() !== "win32";
  let installed = 0;
  let skipped = 0;
  let updated = 0;

  for (const name of skillNames) {
    const source = resolve(join(distSkills, name));
    const target = join(targetBase, name);

    // If target exists and is not a symlink, never overwrite (user's own skill)
    if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
      console.log(c.dim(`  SKIP ${name} (existing user skill, not a symlink)`));
      skipped++;
      continue;
    }

    // If target is an existing symlink, check if it already points to the right place
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      const currentTarget = readlinkSync(target);
      if (resolve(currentTarget) === source) {
        // Already correct
        installed++;
        continue;
      }
      // Stale symlink — remove and recreate
      unlinkSync(target);
      updated++;
    }

    if (useSymlinks) {
      symlinkSync(source, target);
    } else {
      // Windows: copy the SKILL.md
      mkdirSync(target, { recursive: true });
      copyFileSync(join(source, "SKILL.md"), join(target, "SKILL.md"));
    }
    installed++;
  }

  line();
  const method = useSymlinks ? "symlinked" : "copied";
  if (updated > 0) {
    console.log(c.ok(`${installed} stubs ${method}, ${updated} updated, ${skipped} skipped (user skills).`));
  } else {
    console.log(c.ok(`${installed} skill stubs ${method} to ~/.claude/skills/.`));
    if (skipped > 0) {
      console.log(c.dim(`  ${skipped} skipped (existing user skills not managed by PAI).`));
    }
  }
  return true;
}
