#!/usr/bin/env node
/**
 * Build TypeScript hooks into standalone .mjs files using esbuild.
 *
 * Each hook is fully self-contained — lib/ dependencies are inlined.
 * Output: dist/hooks/<name>.mjs with #!/usr/bin/env node shebang.
 *
 * With --sync: also creates/updates symlinks (or copies on Windows) from
 * ~/.claude/Hooks/ and ~/.claude/ to the built/source files. This ensures
 * that `bun run build` is the only step needed to deploy hook updates.
 */

import { buildSync } from "esbuild";
import {
  readdirSync,
  statSync,
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, resolve, basename } from "path";
import { homedir, platform } from "os";

const HOOKS_SRC = "src/hooks/ts";
const HOOKS_OUT = "dist/hooks";
const doSync = process.argv.includes("--sync");

// Collect all .ts entry points (skip lib/ — those are bundled into each hook)
function collectEntryPoints(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "lib") continue;
    if (statSync(full).isDirectory()) {
      entries.push(...collectEntryPoints(full));
    } else if (name.endsWith(".ts")) {
      entries.push(full);
    }
  }
  return entries;
}

const entryPoints = collectEntryPoints(HOOKS_SRC);

console.log(`Building ${entryPoints.length} hooks with esbuild...`);

for (const entry of entryPoints) {
  const outfile = join(HOOKS_OUT, basename(entry).replace(/\.ts$/, ".mjs"));

  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile,
    sourcemap: true,
  });

  chmodSync(outfile, 0o755);
}

console.log(`✔ ${entryPoints.length} hooks built to ${HOOKS_OUT}/`);

// ---------------------------------------------------------------------------
// --sync: Symlink (or copy on Windows) all deployable files to ~/.claude/
// ---------------------------------------------------------------------------

if (doSync) {
  const useSymlinks = platform() !== "win32";
  const claudeDir = join(homedir(), ".claude");
  const hooksTarget = join(claudeDir, "Hooks");
  mkdirSync(hooksTarget, { recursive: true });

  let created = 0;
  let updated = 0;
  let current = 0;

  /**
   * Ensure `target` is a symlink (or copy on Windows) pointing to `source`.
   * Replaces stale symlinks and plain-file copies with correct symlinks.
   * Never overwrites non-symlink, non-PAI files (user's own scripts).
   */
  function syncFile(source, target) {
    const absSource = resolve(source);

    if (!existsSync(absSource)) {
      console.warn(`  ⚠ Source not found: ${source}`);
      return;
    }

    // Check existing target (lstat doesn't follow symlinks)
    let isUpdate = false;
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        if (resolve(readlinkSync(target)) === absSource) {
          current++;
          return;
        }
        unlinkSync(target);
        isUpdate = true;
      } else if (stat.isFile()) {
        unlinkSync(target);
        isUpdate = true;
      } else {
        return; // Directory or something unexpected — don't touch
      }
    } catch {
      // Target doesn't exist — fresh install
    }

    if (useSymlinks) {
      symlinkSync(absSource, target);
    } else {
      copyFileSync(absSource, target);
      chmodSync(target, 0o755);
    }

    if (isUpdate) {
      updated++;
    } else {
      created++;
    }
  }

  // 1. TypeScript hooks: dist/hooks/*.mjs → ~/.claude/Hooks/*.mjs
  const mjsFiles = readdirSync(HOOKS_OUT).filter((f) => f.endsWith(".mjs"));
  for (const filename of mjsFiles) {
    syncFile(join(HOOKS_OUT, filename), join(hooksTarget, filename));
  }

  // 2. Shell hooks: src/hooks/*.sh → ~/.claude/Hooks/pai-*.sh
  const shellHooks = [
    ["src/hooks/pre-compact.sh", "pai-pre-compact.sh"],
    ["src/hooks/session-stop.sh", "pai-session-stop.sh"],
  ];
  for (const [src, destName] of shellHooks) {
    if (existsSync(src)) {
      syncFile(src, join(hooksTarget, destName));
    }
  }

  // 3. Root scripts: statusline + tab-color → ~/.claude/
  const rootScripts = ["statusline-command.sh", "tab-color-command.sh"];
  for (const script of rootScripts) {
    if (existsSync(script)) {
      syncFile(script, join(claudeDir, script));
    }
  }

  const parts = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (current > 0) parts.push(`${current} current`);
  console.log(`✔ Hook symlinks synced: ${parts.join(", ")}`);
}
