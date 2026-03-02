#!/usr/bin/env node
/**
 * Build TypeScript hooks into standalone .mjs files using esbuild.
 *
 * Each hook is fully self-contained — lib/ dependencies are inlined.
 * Output: dist/hooks/<name>.mjs with #!/usr/bin/env node shebang.
 */

import { buildSync } from "esbuild";
import { readdirSync, statSync, chmodSync } from "fs";
import { join, relative, basename } from "path";

const HOOKS_SRC = "src/hooks/ts";
const HOOKS_OUT = "dist/hooks";

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
