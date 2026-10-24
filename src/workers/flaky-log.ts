/**
 * flaky-log.ts — keeps the batch output of a test file that failed in the
 * merge gate's parallel run and passed alone, so the flake can be diagnosed.
 * One text file per flake under <logDir>/workers/flaky, the last 20 per file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FLAKY_KEEP = 20;
const CONTEXT_LINES = 40;

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/** `src/router/limits.test.ts` -> `src-router-limits.test.ts` */
export const flakySlug = (file: string): string => file.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");

/** `<logDir>/flaky`: the gate's logDir is the workers log dir already. */
export const flakyDir = (logDir: string): string => join(logDir, "flaky");

/** The batch failure text for one file: failing tests, the first error with context, the vitest summary. */
export function extractFlakyText(output: string, file: string): { names: string[]; error: string; summary: string } {
  const lines = stripAnsi(output).split("\n");
  const names = [...new Set(lines.filter((l) => /^\s*(?:FAIL|❯|×)\s/.test(l) && l.includes(file)).map((l) => l.trim()))];
  const start = lines.findIndex((l) => /^\s*FAIL\s/.test(l) && l.includes(file));
  let error = "";
  if (start >= 0) {
    const rel = lines.slice(start).findIndex((l) => /(Assertion|Type|Reference|Range)?Error\b|expected .* to |Timeout|timed out/.test(l));
    const from = rel >= 0 ? start + rel : start;
    error = lines.slice(Math.max(start, from - 5), Math.max(start, from - 5) + CONTEXT_LINES).join("\n");
  }
  const sum = lines.findIndex((l) => /^\s*Test Files\s/.test(l));
  const summary = sum >= 0 ? lines.slice(sum, sum + 6).join("\n").trim() : "";
  return { names, error, summary };
}

/** Writes the log for one flaky file and prunes to the newest FLAKY_KEEP; returns the path, null if it cannot write. */
export function saveFlakyLog(dir: string, file: string, batchOutput: string, load: { files: number; at: Date }): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const slug = flakySlug(file);
    const ts = load.at.toISOString().replace(/[:.]/g, "-");
    const t = extractFlakyText(batchOutput, file);
    const text = [
      `file: ${file}`,
      `time: ${load.at.toISOString()}`,
      `batch load: ${load.files} files in the parallel run`,
      "",
      "failing tests:",
      ...(t.names.length ? t.names : ["(none parsed)"]),
      "",
      "first error:",
      t.error || "(none parsed)",
      "",
      "vitest summary:",
      t.summary || "(none)",
      "",
    ].join("\n");
    const path = join(dir, `${slug}-${ts}.txt`);
    writeFileSync(path, text);
    const mine = readdirSync(dir).filter((f) => f.startsWith(`${slug}-`) && /^\d{4}-\d\d-\d\dT[\d-]+Z\.txt$/.test(f.slice(slug.length + 1))).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - FLAKY_KEEP))) rmSync(join(dir, old), { force: true });
    return path;
  } catch {
    return null;
  }
}

export interface FlakyRow {
  slug: string;
  file: string;
  count: number;
  latest: string;
}

/** Files by flake count (most first) with the newest log path. */
export function listFlaky(dir: string): FlakyRow[] {
  if (!existsSync(dir)) return [];
  const by = new Map<string, FlakyRow>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".txt")).sort()) {
    const m = /^(.*)-\d{4}-\d\d-\d\dT[\d-]+Z\.txt$/.exec(f);
    if (!m) continue;
    const row = by.get(m[1]) ?? { slug: m[1], file: m[1], count: 0, latest: "" };
    row.count++;
    row.latest = join(dir, f);
    if (row.count === 1 || !row.file.includes("/")) {
      const first = /^file: (.*)$/m.exec(readFileSync(join(dir, f), "utf8"));
      if (first) row.file = first[1];
    }
    by.set(m[1], row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

export function flakyTable(rows: FlakyRow[]): string {
  if (!rows.length) return "(no flaky tests recorded)";
  return rows.map((r) => `  ${String(r.count).padStart(3)}x  ${r.file}  ${r.latest}`).join("\n");
}
