/**
 * `pai worker bench` core: plan expansion, load gate and result aggregation.
 * The suite (a directory with tasks/<name>/, run.sh, grade.sh) stays project-specific; this only orchestrates.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

export const PROMPTS = ["task", "spec", "precise"] as const;
export type Prompt = (typeof PROMPTS)[number];

export interface Arm {
  task: string;
  provider: string;
  prompt: Prompt;
  repeat: number;
}

export interface GradeRow {
  task: string;
  provider: string;
  prompt: Prompt;
  verdict: string;
  wall?: number;
  turns?: number;
}

export function suiteTasks(suite: string): string[] {
  const dir = join(suite, "tasks");
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** task × provider × repeat, task-major so one task's arms start together. */
export function planArms(tasks: string[], providers: string[], prompt: Prompt, repeat: number): Arm[] {
  const arms: Arm[] = [];
  for (const task of tasks) for (const provider of providers) for (let r = 1; r <= repeat; r++) arms.push({ task, provider, prompt, repeat: r });
  return arms;
}

/** Start now only when a slot is free and the machine is quiet enough. */
export function gateDecision(load: number, maxLoad: number, running: number, maxParallel: number): "go" | "wait-slot" | "wait-load" {
  if (running >= maxParallel) return "wait-slot";
  return load > maxLoad ? "wait-load" : "go";
}

/** Arm id is <task>-<provider>[-spec|-precise]-<hhmmss>; calibration rows (`fix`, `parent`) have none. */
export function parseRow(line: string): GradeRow | undefined {
  const c = line.split("\t");
  const [task, result, verdict] = c;
  if (!task || !result || result === "fix" || result === "parent" || result === "result") return undefined;
  const m = result.startsWith(`${task}-`) ? /^(.+?)(?:-(spec|precise))?-\d{6}$/.exec(result.slice(task.length + 1)) : null;
  if (!m) return undefined;
  const num = (s?: string) => (s !== undefined && s !== "" && !Number.isNaN(Number(s)) ? Number(s) : undefined);
  return { task, provider: m[1], prompt: (m[2] as Prompt) ?? "task", verdict, wall: num(c[7]), turns: num(c[8]) };
}

export function parseRows(tsv: string): GradeRow[] {
  return tsv.split("\n").map(parseRow).filter((r): r is GradeRow => !!r);
}

function median(xs: number[]): string {
  if (!xs.length) return "-";
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return String(s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10);
}

/** One line per provider × prompt: pass/total (void excluded), median wall minutes, median turns. */
export function aggregate(rows: GradeRow[]): string {
  const groups = new Map<string, GradeRow[]>();
  for (const r of rows) {
    const k = `${r.provider}\t${r.prompt}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = ["| provider | prompt | pass/total | median wall (min) | median turns |", "| --- | --- | --- | --- | --- |"];
  for (const [k, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const graded = rs.filter((r) => r.verdict === "pass" || r.verdict === "fail");
    const pass = graded.filter((r) => r.verdict === "pass").length;
    const [provider, prompt] = k.split("\t");
    out.push(`| ${provider} | ${prompt} | ${pass}/${graded.length} | ${median(rs.flatMap((r) => (r.wall === undefined ? [] : [r.wall])))} | ${median(rs.flatMap((r) => (r.turns === undefined ? [] : [r.turns])))} |`);
  }
  return out.join("\n");
}

export function readLoad(): number {
  return loadavg()[0];
}

export function readThermal(): string {
  try {
    return execFileSync("notifyutil", ["-g", "com.apple.system.thermalpressurelevel"], { encoding: "utf-8" }).trim().split(/\s+/).pop() ?? "?";
  } catch {
    return "?";
  }
}

function sh(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("sh", [script, ...args], { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.on("error", () => resolve(out));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BenchOptions {
  suite: string;
  arms: Arm[];
  maxParallel: number;
  maxLoad: number;
  log: (s: string) => void;
}

/** Run every arm through the suite's run.sh then grade.sh; returns this run's grade rows. */
export async function runBench(o: BenchOptions): Promise<GradeRow[]> {
  const rows: GradeRow[] = [];
  const envFile = join(o.suite, "bench-env.tsv");
  if (!existsSync(envFile)) writeFileSync(envFile, "arm\tload\tthermal\n");
  let running = 0;
  const jobs: Promise<void>[] = [];
  for (const arm of o.arms) {
    for (;;) {
      const d = gateDecision(readLoad(), o.maxLoad, running, o.maxParallel);
      if (d === "go") break;
      if (d === "wait-load") o.log(`load ${readLoad().toFixed(1)} > ${o.maxLoad}: waiting before ${arm.task}/${arm.provider}`);
      await sleep(d === "wait-load" ? 30_000 : 5_000);
    }
    running++;
    const load = readLoad().toFixed(1);
    const thermal = readThermal();
    jobs.push(
      (async () => {
        try {
          const env = { ...process.env, PROMPT: arm.prompt };
          const started = await sh(join(o.suite, "run.sh"), [arm.task, arm.provider], o.suite, env);
          const id = /^arm (\S+) ended/m.exec(started)?.[1];
          if (!id) return o.log(`${arm.task}/${arm.provider}: no arm id in run.sh output`);
          appendFileSync(envFile, `${id}\t${load}\t${thermal}\n`);
          const graded = await sh(join(o.suite, "grade.sh"), [arm.task, id], o.suite, process.env);
          const row = parseRow(graded.trim().split("\n").pop() ?? "");
          if (row) rows.push(row);
          o.log(`${id}: ${row?.verdict ?? "ungraded"} (load ${load}, thermal ${thermal})`);
        } finally {
          running--;
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return rows;
}

export function readSuiteRows(suite: string): GradeRow[] {
  return parseRows(readFileSync(join(suite, "rows.tsv"), "utf-8"));
}

export function writeResults(suite: string, rows: GradeRow[]): string {
  const file = join(suite, "results.md");
  writeFileSync(file, `# A/B results\n\nGenerated by \`pai worker bench\`; void rows excluded from pass/total.\n\n${aggregate(rows)}\n`);
  return file;
}
