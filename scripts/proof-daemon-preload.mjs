#!/usr/bin/env node
/**
 * proof-daemon-preload.mjs — build-level check for the daemon's lazy dist imports.
 *
 * Node resolves a dynamic import() against the file system per (importing
 * module, specifier): a chunk deleted after startup fails with "Cannot find
 * module" even when another module already loaded it. Only STATIC imports are
 * linked at startup, so the daemon must not depend on lazy relative import()s.
 *
 * Walks the daemon chunk's static import closure in dist/ and lists every lazy
 * relative import("./chunk.mjs") left in it, per file. `--strict` exits 1 if
 * the daemon-owned files (daemon/factory/dispatcher/scheduler/embed paths)
 * still have any.
 *
 * Usage: npm run build && node scripts/proof-daemon-preload.mjs [--strict]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const entry = readFileSync(join(dist, "daemon", "index.mjs"), "utf8");
const first = [...entry.matchAll(/from "\.\.\/([\w.-]+\.mjs)"/g)].map((m) => m[1]);
const seen = new Set();
const stack = [...first];
while (stack.length) {
  const f = stack.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  const src = readFileSync(join(dist, f), "utf8");
  for (const m of src.matchAll(/(?:from|import) "\.\/([\w.-]+\.mjs)"/g)) stack.push(m[1]);
}

let total = 0;
for (const f of [...seen].sort()) {
  const src = readFileSync(join(dist, f), "utf8");
  const lazy = [...src.matchAll(/import\("\.\/([\w.-]+\.mjs)"\)/g)].map((m) => m[1]);
  if (!lazy.length) continue;
  total += lazy.length;
  console.log(`${f}: ${lazy.join(", ")}`);
}
console.log(`static closure: ${seen.size} chunks, lazy relative imports left: ${total}`);
const daemon = [...seen].find((f) => readFileSync(join(dist, f), "utf8").includes("Starting scheduled embed pass"));
const own = readFileSync(join(dist, daemon), "utf8").match(/import\("\.\/[\w.-]+\.mjs"\)/g) ?? [];
console.log(`daemon chunk ${daemon}: lazy relative imports: ${own.length}`);
if (process.argv.includes("--strict") && own.length) process.exitCode = 1;
