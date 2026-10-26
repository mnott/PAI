/**
 * kept.ts — read tests/KEPT.md, the register of governed test files:
 * `| file | class | evidence |` rows. The one parser the audit, the prune
 * and the PreToolUse guard share.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface KeptEntry {
  file: string;
  /** Evidence classes, e.g. ["a", "b"]. */
  classes: string[];
  evidence: string;
}

/** Rows of the KEPT.md table text (header and separator rows skipped). */
export function parseKept(md: string): KeptEntry[] {
  const out: KeptEntry[] = [];
  for (const line of md.split("\n")) {
    const m = /^\|\s*([^|\s][^|]*?)\s*\|\s*([a-c](?:\s*,\s*[a-c])*)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (m) out.push({ file: m[1].replace(/^`|`$/g, ""), classes: m[2].split(",").map((c) => c.trim()), evidence: m[3] });
  }
  return out;
}

/** The register of a repo; [] when it has none. */
export function readKept(repo: string): KeptEntry[] {
  const p = join(repo, "tests", "KEPT.md");
  return existsSync(p) ? parseKept(readFileSync(p, "utf8")) : [];
}

export const KEPT_HEADER =
  "# Kept tests\n\nTests are governed: a test file stays only with evidence. (a) a real product bug it guarded (fixing commit), (b) it pins a security guard or destructive-operation block, (c) it pins an external contract other software depends on. One-time tests are discarded after use. Add a file here with its evidence or do not commit it.\n\n| File | Class | Evidence |\n| --- | --- | --- |\n";

export function renderKept(rows: KeptEntry[]): string {
  return KEPT_HEADER + rows.map((r) => `| ${r.file} | ${r.classes.join(",")} | ${r.evidence} |`).join("\n") + "\n";
}
