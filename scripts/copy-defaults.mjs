#!/usr/bin/env node
/**
 * copy-defaults.mjs — ship the defaults files into dist.
 *
 * src/config/defaults/config.yaml and workers.yaml are the shipped policy
 * values (thresholds, limits, intervals, lists, mappings) that
 * src/config/shipped-defaults.ts loads first and deep-merges UNDER the user's
 * ~/.pai/config.yaml and workers.yaml. tsdown bundles code only, so this step
 * copies the YAML files to dist/config/defaults/ — the same directory the
 * bundled loader module resolves them from (dirname(import.meta.url)).
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = resolve("src/config/defaults");
const DIST_DIR = resolve(process.argv[2] ?? "dist", "config/defaults");
const FILES = ["config.yaml", "workers.yaml", "tool-call-rules.default.yaml"];

mkdirSync(DIST_DIR, { recursive: true });
for (const name of FILES) {
  const src = join(SRC_DIR, name);
  if (!existsSync(src)) {
    console.error(`copy-defaults: ${src} is missing — the shipped defaults must ship with the build`);
    process.exit(1);
  }
  // sanity: the file must parse as a YAML mapping (cheap check, no yaml dep here)
  const text = readFileSync(src, "utf8");
  if (!text.trim().length) {
    console.error(`copy-defaults: ${src} is empty`);
    process.exit(1);
  }
  copyFileSync(src, join(DIST_DIR, name));
  console.log(`copy-defaults: ${src} → ${join(DIST_DIR, name)}`);
}

// the saved cockpit layout is optional: it exists once `pai cockpit layout export` has written it
const LAYOUT = join(SRC_DIR, "cockpit-layout.json");
if (existsSync(LAYOUT)) {
  copyFileSync(LAYOUT, join(DIST_DIR, "cockpit-layout.json"));
  console.log(`copy-defaults: ${LAYOUT} → ${join(DIST_DIR, "cockpit-layout.json")}`);
}

// esbuild bundles (tests, hooks) emit into directories next to where the
// loader module sits; a bundle's shippedDefaultsDir() falls back to
// <cwd>/src/config/defaults, which is SRC_DIR itself — nothing extra needed.
