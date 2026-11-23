/**
 * kept.ts — read tests/KEPT.md, the register of governed test files:
 * `| file | class | evidence |` rows. The one parser the audit, the prune
 * and the PreToolUse guard share.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** The ledger path a repo uses: an existing `tests/KEPT.md` or `Tests/KEPT.md`, else the lowercase default. */
export function keptLedgerPath(repo: string): string {
  const lower = join(repo, "tests", "KEPT.md");
  if (existsSync(lower)) return lower;
  const upper = join(repo, "Tests", "KEPT.md");
  return existsSync(upper) ? upper : lower;
}

export interface KeepResult {
  /** The ledger file written (or left untouched on a duplicate). */
  path: string;
  /** False when the file was already registered; `existing` holds its row. */
  added: boolean;
  existing?: KeptEntry;
  /** The row appended (undefined on a duplicate). */
  row?: KeptEntry;
}

/**
 * Append exactly one row to the repo's KEPT.md ledger: `pai tests keep`.
 * Creates the file with its header when missing; refuses a duplicate file
 * (returning the existing row, writing nothing); never rewrites other rows —
 * the file is read, the new row appended after the last table row, and written
 * back whole.
 */
export function appendKept(repo: string, file: string, classes: string[], evidence: string): KeepResult {
  const path = keptLedgerPath(repo);
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, "utf8") : "";
  const rows = parseKept(text);
  const dup = rows.find((r) => r.file === file);
  if (dup) return { path, added: false, existing: dup };
  const row: KeptEntry = { file, classes, evidence };
  if (!exists) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderKept([row]));
    return { path, added: true, row };
  }
  // append-only: keep every existing byte, add one row after the last table row
  const lines = text.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^\|/.test(lines[i])) last = i;
  const newRow = `| ${row.file} | ${row.classes.join(",")} | ${row.evidence} |`;
  if (last < 0) {
    // a ledger with no table yet: append the header's table plus the row
    lines.push("", "| File | Class | Evidence |", "| --- | --- | --- |", newRow);
  } else {
    lines.splice(last + 1, 0, newRow);
  }
  writeFileSync(path, lines.join("\n"));
  return { path, added: true, row };
}
