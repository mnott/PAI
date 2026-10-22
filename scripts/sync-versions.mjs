#!/usr/bin/env node
/**
 * sync-versions.mjs — write package.json's version into every plugin manifest.
 *
 * The manifests drifted (0.60.0 / 0.7.0 against 0.72.1) because each was bumped
 * by hand. Run from `npm run build` and the `version` lifecycle script, so a
 * release bump propagates. Only the top-level "version" line is rewritten; the
 * rest of each file stays byte-identical.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function manifestPaths() {
  const fixed = [".claude-plugin/plugin.json", "pai-plugin.json", "gemini-extension.json", ".cursor/plugin.json"];
  const dir = join(root, "plugins");
  const nested = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "plugin.json")))
        .map((e) => `plugins/${e.name}/plugin.json`)
    : [];
  return [...fixed, ...nested].filter((p) => existsSync(join(root, p)));
}

export function syncVersions() {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const changed = [];
  for (const rel of manifestPaths()) {
    const file = join(root, rel);
    const text = readFileSync(file, "utf8");
    const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
    if (next !== text) {
      writeFileSync(file, next);
      changed.push(rel);
    }
  }
  return { version, changed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, changed } = syncVersions();
  console.log(`manifests at ${version}${changed.length ? `; updated ${changed.join(", ")}` : " (already in sync)"}`);
}
