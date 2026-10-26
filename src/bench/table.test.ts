import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRow, realStats, setStats } from "./table.js";

let base: string;
beforeEach(() => void (base = mkdtempSync(join(tmpdir(), "bench-table-"))));
afterEach(() => rmSync(base, { recursive: true, force: true }));

const row = parseRow("gyro-m", "local");
const put = (p: string, body: unknown) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
};

function setRun(set: string, rep: number, res: object, o: { route?: string; worker?: object | null } = {}) {
  put(join(base, "results", set, "gyro-m", `rep${rep}.json`), { status: "ok", n: 10, passed: 8, wall_s: 100, tok_per_s: 50, tasks: [{}], ...res });
  const w = join(base, "work", set, "gyro-m", `rep${rep}`);
  put(join(w, "worker.err"), `route ${o.route ?? "gyro-m/qwen"} ok\n`);
  put(join(w, "worker.json"), o.worker === null ? "" : (o.worker ?? { provider: "gyro-m", worker_id: "w1" }));
}

describe("setStats", () => {
  it("counts a clean run", () => {
    setRun("easy", 1, {});
    const notes: string[] = [];
    expect(setStats(base, row, "easy", notes)).toEqual({ pass: 80, tps: 50, spt: 10, reps: 1 });
  });

  it("excludes a run whose route names another provider", () => {
    setRun("easy", 1, {}, { route: "anthropic/sonnet" });
    setRun("easy", 2, { passed: 10 });
    const notes: string[] = [];
    const s = setStats(base, row, "easy", notes)!;
    expect(s.reps).toBe(1);
    expect(s.pass).toBe(100);
    expect(notes.join()).toContain("excluded easy/gyro-m/rep1");
  });

  it("excludes a run that ended on another provider or with several workers", () => {
    setRun("easy", 1, {}, { worker: { provider: "anthropic", worker_id: "w1" } });
    setRun("easy", 2, {}, { worker: { provider: "gyro-m", worker_ids: ["a", "b"] } });
    expect(setStats(base, row, "easy", [])).toBeNull();
  });

  it("counts a loop-stopped run for pass but not for time", () => {
    setRun("hard", 1, {});
    setRun("hard", 2, { status: "error", error: "loop-stopped: repeated writes", passed: 2, wall_s: 9000, tok_per_s: 5 });
    const s = setStats(base, row, "hard", [])!;
    expect(s.reps).toBe(2);
    expect(s.pass).toBe(50); // (8+2)/20
    expect(s.spt).toBe(10); // only the clean run
    expect(s.tps).toBe(50);
  });

  it("counts a killed run (empty worker.json) for pass but not for time", () => {
    setRun("hard", 1, { passed: 4, wall_s: 7200 }, { worker: null });
    const s = setStats(base, row, "hard", [])!;
    expect(s.pass).toBe(40);
    expect(s.spt).toBeNull();
  });

  it("drops an errored run that graded nothing", () => {
    setRun("short", 1, { status: "error", error: "boom", tasks: [] });
    expect(setStats(base, row, "short", [])).toBeNull();
  });
});

describe("realStats", () => {
  function realRep(rep: number, res: object, workers: Record<string, object | null>) {
    put(join(base, "results", "real", "gyro-m", `rep${rep}.json`), { n: 5, passed: 3, tok_per_s: 40, ...res });
    for (const [t, w] of Object.entries(workers)) put(join(base, "work", "real", `gyro-m-rep${rep}`, `${t}.worker.json`), w === null ? "" : w);
  }
  const ok = (s: number) => ({ provider: "gyro-m", worker_id: "w", duration_ms: s * 1000 });

  it("leaves tasks over 900 s out of s/task but keeps their pass", () => {
    realRep(1, {}, { a: ok(100), b: ok(300), c: ok(901), d: null });
    const notes: string[] = [];
    const r = realStats(base, row, notes)!;
    expect(r).toMatchObject({ passed: 3, n: 5, spt: 200, tps: 40, reps: 1 });
    expect(notes.join()).toContain("2 task(s) over 900 s or cut");
  });

  it("leaves a rep with a task on another provider out entirely", () => {
    realRep(1, {}, { a: ok(100), b: { provider: "anthropic", worker_id: "w", duration_ms: 1000 } });
    realRep(2, { passed: 5 }, { a: ok(50) });
    const r = realStats(base, row, [])!;
    expect(r).toMatchObject({ passed: 5, n: 5, reps: 1, spt: 50 });
  });
});

describe("parseRow", () => {
  it("accepts key, key:provider and name=key:provider", () => {
    expect(parseRow("a", "local")).toMatchObject({ name: "a", key: "a", provider: "a" });
    expect(parseRow("k:p", "cloud")).toMatchObject({ name: "k", key: "k", provider: "p", where: "cloud" });
    expect(parseRow("N=k:p", "local")).toMatchObject({ name: "N", key: "k", provider: "p" });
  });
});
