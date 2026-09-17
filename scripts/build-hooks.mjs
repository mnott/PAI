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
  renameSync,
  rmSync,
} from "fs";
import { join, resolve, basename } from "path";
import { homedir, platform } from "os";
import { isInsideWorkerWorktree } from "./lib/sync-guard.mjs";

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

// Build into a staging directory, then rename each artefact into place.
//
// ~/.claude/Hooks/*.mjs are symlinks to these files, and every LIVE Claude Code
// session executes them on each tool call. esbuild truncates-then-writes, so
// building straight to the output path leaves a window in which the file does
// not exist — any hook firing during a build in another session dies with
// "No such file or directory". That is not hypothetical: a rebuild here breaks
// hooks in every other session that happens to fire during it.
//
// rename(2) within one filesystem is atomic, so a concurrent session sees
// either the previous build or the new one, never a partial or absent file.
const STAGING = join(HOOKS_OUT, ".staging");
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

for (const entry of entryPoints) {
  const name = basename(entry).replace(/\.ts$/, ".mjs");
  const staged = join(STAGING, name);

  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: staged,
    sourcemap: true,
  });

  chmodSync(staged, 0o755);

  // The sourceMappingURL comment is a bare filename, so the map must land in
  // the same directory as the module. Move it first: a stale map for a moment
  // is harmless, a missing module is not.
  const stagedMap = `${staged}.map`;
  if (existsSync(stagedMap)) {
    renameSync(stagedMap, join(HOOKS_OUT, `${name}.map`));
  }
  renameSync(staged, join(HOOKS_OUT, name));
}

rmSync(STAGING, { recursive: true, force: true });

console.log(`✔ ${entryPoints.length} hooks built to ${HOOKS_OUT}/`);

// ---------------------------------------------------------------------------
// Standalone worker status-line: src/workers/standalone/status-line.ts →
// dist/worker-status-line.mjs (same atomic-staging rules; it runs on every
// statusline refresh of every live session).
// ---------------------------------------------------------------------------

// [entry, output name in dist/hooks/]
const STANDALONE_ENTRIES = [
  ["src/workers/standalone/status-line.ts", "worker-status-line.mjs"],
  // detached proxy for openai-protocol providers; spawned from dist, not
  // symlinked into ~/.claude, so it is NOT in the --sync list below
  ["src/workers/standalone/proxy.ts", "worker-proxy.mjs"],
];

mkdirSync(STAGING, { recursive: true });
for (const [entry, name] of STANDALONE_ENTRIES) {
  const staged = join(STAGING, name);
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: staged,
    sourcemap: true,
  });
  chmodSync(staged, 0o755);
  const stagedMap = `${staged}.map`;
  if (existsSync(stagedMap)) {
    renameSync(stagedMap, join(HOOKS_OUT, `${name}.map`));
  }
  mkdirSync(HOOKS_OUT, { recursive: true });
  renameSync(staged, join(HOOKS_OUT, name));
}

rmSync(STAGING, { recursive: true, force: true });

console.log(
  `✔ ${STANDALONE_ENTRIES.length} standalone script(s) built to ${HOOKS_OUT}/ (${STANDALONE_ENTRIES.map(([, n]) => n).join(", ")})`
);

// ---------------------------------------------------------------------------
// --sync: Symlink (or copy on Windows) all deployable files to ~/.claude/
// ---------------------------------------------------------------------------

if (doSync && isInsideWorkerWorktree(process.cwd())) {
  // Never repoint the live ~/.claude symlinks at a worktree that `pai worker
  // merge` will delete — see scripts/lib/sync-guard.mjs.
  console.log("✔ Hook symlinks skipped: build runs inside a worker worktree");
} else if (doSync) {
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
  // (worker-proxy.mjs is spawned from dist, not a hook — skip it)
  const mjsFiles = readdirSync(HOOKS_OUT).filter((f) => f.endsWith(".mjs") && f !== "worker-proxy.mjs");
  for (const filename of mjsFiles) {
    syncFile(join(HOOKS_OUT, filename), join(hooksTarget, filename));
  }

  // 2. Shell hooks: src/hooks/*.sh → ~/.claude/Hooks/pai-*.sh
  const shellHooks = [
    ["src/hooks/pre-compact.sh", "pai-pre-compact.sh"],
    ["src/hooks/session-stop.sh", "pai-session-stop.sh"],
    ["src/hooks/session-autosave.sh", "pai-session-autosave.sh"],
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

  // 4. Standalone worker status-line: dist/worker-status-line.mjs → ~/.claude/
  syncFile(join(HOOKS_OUT, "worker-status-line.mjs"), join(claudeDir, "worker-status-line.mjs"));

  const parts = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (current > 0) parts.push(`${current} current`);
  console.log(`✔ Hook symlinks synced: ${parts.join(", ")}`);
}
