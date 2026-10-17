#!/usr/bin/env node
/**
 * Generate the per-area command reference ("man pages") from the live command
 * definitions.
 *
 * Source of truth: src/cli2 (the definitions `pai help` reads). The built CLI
 * writes the pages itself:
 *
 *   docs/commands/<area>.md   — one page per top-level command
 *   docs/commands/README.md   — index (area table + flat list of every command)
 *
 * Hand-written examples are spliced in from docs/commands/_examples/<area>.md
 * when present (the only part that isn't generated).
 *
 * Never edit the generated files by hand — they are overwritten on every build.
 * Run automatically during `bun run build`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli2", "index.mjs");
const OUT_DIR = process.env.PAI_DOCS_OUT ?? join(ROOT, "docs", "commands");

if (!existsSync(CLI)) {
  console.error(`✖ ${CLI} not found — run tsdown first.`);
  process.exit(1);
}

const r = spawnSync(process.execPath, [CLI, "doc", "--dir", OUT_DIR, "--examples", join(ROOT, "docs", "commands", "_examples")], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (r.status !== 0) {
  console.error("✖ build-docs failed: `pai doc --dir` exited with", r.status);
  process.exit(1);
}
console.log(`✔ ${r.stdout.trim()} (docs/commands)`);
