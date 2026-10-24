#!/usr/bin/env node
// Duplicate-code gate: runs jscpd over src/ with a fixed threshold and fails on any clone
// that is not in scripts/duplicates-baseline.json. The baseline can only shrink:
//   node scripts/check-duplicates.mjs          check (exit 1 on a new clone)
//   node scripts/check-duplicates.mjs --prune  drop baseline entries that are fixed
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "duplicates-baseline.json");
const THRESHOLD = ["--min-lines", "8", "--min-tokens", "70"];

const out = mkdtempSync(join(tmpdir(), "pai-jscpd-"));
const run = spawnSync(
  "npx",
  ["-y", "jscpd@4", ...THRESHOLD, "--reporters", "json", "--output", out, "--ignore", "**/*.test.ts,**/*.d.ts", "src"],
  { cwd: root, encoding: "utf8" }
);
const reportPath = join(out, "jscpd-report.json");
if (!existsSync(reportPath)) {
  console.error(`duplicate scan could not run (jscpd exit ${run.status}): ${run.stderr || run.stdout}`);
  process.exit(2);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));

/** Stable id of a clone: both files plus the normalised fragment, so line shifts do not matter. */
const id = (d) => {
  const files = [d.firstFile.name, d.secondFile.name].sort().join(" | ");
  const text = createHash("sha1").update((d.fragment ?? "").replace(/\s+/g, " ")).digest("hex").slice(0, 12);
  return `${files} | ${text}`;
};
const found = new Map(report.duplicates.map((d) => [id(d), d]));
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : [];

if (process.argv.includes("--prune")) {
  const kept = baseline.filter((b) => found.has(b)).sort();
  writeFileSync(baselinePath, JSON.stringify(kept, null, 2) + "\n");
  console.log(`baseline: ${baseline.length} -> ${kept.length} clones`);
  process.exit(0);
}
if (process.argv.includes("--init")) {
  writeFileSync(baselinePath, JSON.stringify([...found.keys()].sort(), null, 2) + "\n");
  console.log(`baseline written: ${found.size} clones`);
  process.exit(0);
}

const known = new Set(baseline);
const fresh = [...found].filter(([k]) => !known.has(k));
if (fresh.length) {
  console.error(`duplicate-code gate: ${fresh.length} new clone(s) (>= ${THRESHOLD[1]} lines); extract one shared function:`);
  for (const [, d] of fresh) {
    console.error(`  ${d.lines} lines: ${d.firstFile.name}:${d.firstFile.start} <-> ${d.secondFile.name}:${d.secondFile.start}`);
  }
  process.exit(1);
}
console.log(`duplicate-code gate: ok (${found.size} baselined clones, none new)`);
