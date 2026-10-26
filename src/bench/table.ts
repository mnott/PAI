/**
 * `pai bench table`: the model comparison table from the bench results.
 * Counting rules (from the night table of 2026-10-25):
 *  - a run counts only if its route line, its ending provider and its single worker id all name the model;
 *  - a loop-stopped or killed run counts for pass %, not for time or tok/s;
 *  - real tasks over 900 s are left out of s/task (their pass/fail still counts);
 *  - a real rep with a task on another provider or with several workers is left out entirely.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProviderOrNative, isLocalProvider, readWorkersSection } from "../workers/config.js";

export const SETS = ["easy", "hard", "short"] as const;
export const REAL_SLOW_S = 900;

export interface TableRow {
  /** Display name; defaults to the key. */
  name: string;
  where: "local" | "cloud";
  /** Results key (directory under results/<set>/ and work/<set>/). */
  key: string;
  /** Provider the runs must have been routed to, run on and ended on; "" = infer from the runs. */
  provider: string;
}

interface SetRun {
  status?: string;
  error?: string | null;
  n: number;
  passed: number;
  wall_s: number;
  tok_per_s?: number | null;
  tasks?: unknown[];
  noTime?: boolean;
}

interface WorkerJson {
  provider?: string;
  worker_id?: string;
  worker_ids?: string[];
  duration_ms?: number;
}

interface SetStats {
  pass: number;
  tps: number | null;
  spt: number | null;
  reps: number;
}

const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
};

const mean = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const workerCount = (w: WorkerJson): number => (w.worker_ids ?? [w.worker_id]).length;
const routeOk = (route: string, provider: string): boolean => route === provider || route.startsWith(provider + "/");

/** "key" or "key:provider" or "name=key:provider" -> TableRow. */
export function parseRow(spec: string, where: TableRow["where"]): TableRow {
  const [head, prov] = spec.split(":");
  const [name, key] = head.includes("=") ? head.split("=") : [head, head];
  return { name, where, key, provider: prov || "" };
}

/** The provider most of a key's non-killed runs ended on (sets and real, all reps); "" when there are none. */
export function inferProvider(base: string, key: string): string {
  const counts = new Map<string, number>();
  const add = (w: WorkerJson | null) => w?.provider && counts.set(w.provider, (counts.get(w.provider) ?? 0) + 1);
  const ls = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);
  for (const set of SETS) {
    for (const rep of ls(join(base, "work", set, key))) add(readJson<WorkerJson>(join(base, "work", set, key, rep, "worker.json")));
  }
  for (const d of ls(join(base, "work", "real")).filter((d) => d.startsWith(`${key}-rep`))) {
    for (const w of ls(join(base, "work", "real", d)).filter((x) => x.endsWith(".worker.json"))) add(readJson<WorkerJson>(join(base, "work", "real", d, w)));
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

const providerIsLocal = (name: string): boolean => {
  try {
    const p = getProviderOrNative(readWorkersSection().workers, name);
    return !p || isLocalProvider(p.baseUrl);
  } catch {
    return true;
  }
};

export function setStats(base: string, row: TableRow, set: string, notes: string[]): SetStats | null {
  const dir = join(base, "results", set, row.key);
  if (!existsSync(dir)) return null;
  const runs: SetRun[] = [];
  for (const f of readdirSync(dir).filter((f) => /^rep\d+\.json$/.test(f)).sort()) {
    const rep = f.replace(".json", "");
    const r = readJson<SetRun>(join(dir, f));
    if (!r) continue;
    const wdir = join(base, "work", set, row.key, rep);
    const errFile = join(wdir, "worker.err");
    const route = existsSync(errFile) ? (readFileSync(errFile, "utf8").match(/route (\S+)/) || [])[1] || "" : "";
    const w = readJson<WorkerJson>(join(wdir, "worker.json")) ?? {};
    const killed = !w.provider; // killed run: worker.json empty, only the start route can be checked
    const endOk = killed || (w.provider === row.provider && workerCount(w) === 1);
    const loopStopped = killed || (r.status === "error" && String(r.error ?? "").startsWith("loop-stopped"));
    const graded = Array.isArray(r.tasks) && r.tasks.length > 0; // status "error" can just mean the model's own report said so
    const id = `${set}/${row.key}/${rep}`;
    if (!routeOk(route, row.provider) || !endOk || (r.status !== "ok" && !loopStopped && !graded)) {
      notes.push(`${row.name}: excluded ${id}: ${!endOk ? `ended on ${w.provider}/${workerCount(w)} workers` : route || r.status}`);
      continue;
    }
    if (loopStopped) {
      r.tok_per_s = null;
      r.noTime = true;
      notes.push(`${id}: loop-stopped, pass counted, time left out`);
    }
    runs.push(r);
  }
  if (!runs.length) return null;
  const n = runs.reduce((s, r) => s + r.n, 0);
  const p = runs.reduce((s, r) => s + r.passed, 0);
  const timed = runs.filter((r) => !r.noTime);
  return {
    pass: (100 * p) / n,
    tps: mean(runs.map((r) => r.tok_per_s ?? 0).filter((x) => x > 0)),
    spt: mean(timed.map((r) => r.wall_s / r.n)),
    reps: runs.length,
  };
}

export function realStats(base: string, row: TableRow, notes: string[]): { passed: number; n: number; tps: number | null; spt: number | null; reps: number } | null {
  const dir = join(base, "results", "real", row.key);
  if (!existsSync(dir)) return null;
  let passed = 0, n = 0, reps = 0;
  const tps: number[] = [];
  const secs: number[] = [];
  for (const f of readdirSync(dir).filter((x) => /^rep\d+\.json$/.test(x)).sort()) {
    const rep = f.replace(".json", "");
    const r = readJson<{ passed?: number; n?: number; tok_per_s?: number | null }>(join(dir, f));
    if (!r) continue;
    const wdir = join(base, "work", "real", `${row.key}-${rep}`);
    const bad: string[] = [];
    const repSecs: number[] = [];
    let left = 0;
    if (existsSync(wdir)) {
      for (const w of readdirSync(wdir).filter((x) => x.endsWith(".worker.json"))) {
        const j = readJson<WorkerJson>(join(wdir, w));
        if (!j?.provider) { left++; continue; } // killed by the per-task cap
        if (j.provider !== row.provider || workerCount(j) !== 1) bad.push(`${w.replace(".worker.json", "")}:${j.provider}`);
        const s = (j.duration_ms ?? 0) / 1000;
        if (!s || s > REAL_SLOW_S) left++;
        else repSecs.push(s);
      }
    }
    if (bad.length) {
      notes.push(`${row.name} real ${rep}: provider mismatch ${bad.join(", ")} -> rep left out`);
      continue;
    }
    if (left) notes.push(`${row.name} real ${rep}: ${left} task(s) over ${REAL_SLOW_S} s or cut, left out of s/task`);
    passed += r.passed ?? 0;
    n += r.n ?? 0;
    if ((r.tok_per_s ?? 0) > 0) tps.push(r.tok_per_s!);
    secs.push(...repSecs);
    reps++;
  }
  return reps ? { passed, n, tps: mean(tps), spt: mean(secs), reps } : null;
}

const pct = (x: number | null | undefined): string => (x == null ? "-" : `${x.toFixed(x === 100 ? 0 : 1)} %`);
const num = (x: number | null | undefined, d = 0): string => (x == null ? "-" : x.toFixed(d));

export function renderTable(base: string, rows: TableRow[]): string {
  const notes: string[] = [];
  const lines = [
    "| Model | Where | easy | hard | short | real | t/s sets | t/s real | s/task sets | s/task real | reps |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const given of rows) {
    let row = given;
    if (!row.provider) {
      const provider = inferProvider(base, row.key);
      row = { ...row, provider, where: provider && !providerIsLocal(provider) ? "cloud" : row.where };
      if (provider) notes.push(`${row.name}: provider ${provider} inferred from the runs; runs on another provider are excluded`);
    }
    const sets = Object.fromEntries(SETS.map((s) => [s, setStats(base, row, s, notes)]));
    const real = realStats(base, row, notes);
    const tps = mean(SETS.map((s) => sets[s]?.tps).filter((x): x is number => x != null));
    const realPct = real && real.n ? (100 * real.passed) / real.n : null;
    lines.push(
      `| ${row.name} | ${row.where} | ${SETS.map((s) => pct(sets[s]?.pass)).join(" | ")} | ${pct(realPct)} | ${num(tps)} | ${num(real?.tps)} | ${SETS.map((s) => num(sets[s]?.spt, 1)).join(" / ")} | ${num(real?.spt)} | ${SETS.map((s) => sets[s]?.reps ?? 0).join("/")}${real ? ` + real ${real.reps}` : ""} |`,
    );
  }
  return [...lines, "", ...notes].join("\n") + "\n";
}
