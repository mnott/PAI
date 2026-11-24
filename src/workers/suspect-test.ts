/**
 * suspect-test.ts — "suspect the test first". The same test failing in runs of 2+ different
 * workers or models within 24 h points at the test (or the task text), not at the model.
 * Index: <logDir>/suspect-tests.json, a flat list of {id, assertion, ts, workerId, model}.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const SUSPECT_WINDOW_MS = 24 * 3600_000;
export const SUSPECT_PHRASE = "check the assertion against the task text before blaming the model";

export interface FailureEntry {
  id: string;
  assertion: string;
  ts: number;
  workerId: string;
  model: string;
}

export interface Suspect {
  id: string;
  assertion: string;
  runs: number;
  models: number;
}

export const suspectIndexPath = (logDir: string): string => join(logDir, "suspect-tests.json");

function load(logDir: string): FailureEntry[] {
  try {
    const p = suspectIndexPath(logDir);
    if (!existsSync(p)) return [];
    const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(v) ? (v as FailureEntry[]) : [];
  } catch {
    return [];
  }
}

/** Adds this run's failing tests; entries older than the window are pruned. Never throws. */
export function recordFailures(logDir: string, workerId: string, model: string, failures: { id: string; assertion?: string }[], now = Date.now()): void {
  if (!failures.length) return;
  try {
    const keep = load(logDir).filter((e) => now - e.ts <= SUSPECT_WINDOW_MS && !(e.workerId === workerId && failures.some((f) => f.id === e.id)));
    for (const f of failures) keep.push({ id: f.id, assertion: (f.assertion ?? "").slice(0, 300), ts: now, workerId, model });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(suspectIndexPath(logDir), JSON.stringify(keep));
  } catch {
    /* best effort */
  }
}

/** Test ids that failed in >=2 distinct workers or models within the last 24 h. */
export function suspects(logDir: string, now = Date.now()): Suspect[] {
  const by = new Map<string, FailureEntry[]>();
  for (const e of load(logDir)) {
    if (now - e.ts > SUSPECT_WINDOW_MS) continue;
    by.set(e.id, [...(by.get(e.id) ?? []), e]);
  }
  const out: Suspect[] = [];
  for (const [id, es] of by) {
    const workers = new Set(es.map((e) => e.workerId)).size;
    const models = new Set(es.map((e) => e.model)).size;
    if (workers >= 2 || models >= 2) out.push({ id, assertion: es[es.length - 1].assertion, runs: workers, models });
  }
  return out;
}

export function suspectLine(s: Suspect): string {
  return `suspect test: ${s.id}${s.assertion ? ` (assertion: ${s.assertion})` : ""} failed in ${s.runs} run(s) by ${s.models} model(s) within 24h: ${SUSPECT_PHRASE}`;
}

/** Suspect lines for the given test names (all suspects when names is omitted). */
export function suspectLines(logDir: string, names?: string[], now = Date.now()): string[] {
  return suspects(logDir, now)
    .filter((s) => !names || names.some((n) => n === s.id || n.includes(s.id) || s.id.includes(n)))
    .map(suspectLine);
}
