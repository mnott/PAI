import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, createWriteStream, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { rotateLog, rotateLogsIn } from "./log-rotate.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "logrot-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");

describe("rotateLog", () => {
  it("leaves a small file alone", async () => {
    const f = join(dir, "a.log"); writeFileSync(f, "x\n");
    expect(await rotateLog(f, 100, 3, 10)).toBe(false);
    expect(existsSync(`${f}.1.gz`)).toBe(false);
  });
  it("archives to .1.gz and keeps the tail", async () => {
    const f = join(dir, "a.log"); const body = lines(200, "A"); writeFileSync(f, body);
    expect(await rotateLog(f, 100, 3, 500)).toBe(true);
    expect(gunzipSync(readFileSync(`${f}.1.gz`)).toString()).toBe(body);
    const live = readFileSync(f, "utf8");
    expect(live.length).toBeLessThanOrEqual(500);
    expect(body.endsWith(live)).toBe(true);
    expect(live.startsWith("A line")).toBe(true);
    expect(live.endsWith("A line 199\n")).toBe(true);
  });
  it("keep=3 drops the oldest", async () => {
    const f = join(dir, "a.log");
    for (const t of ["A", "B", "C", "D"]) { writeFileSync(f, lines(100, t)); await rotateLog(f, 100, 3, 50); }
    expect(existsSync(`${f}.4.gz`)).toBe(false);
    expect(gunzipSync(readFileSync(`${f}.1.gz`)).toString().startsWith("D")).toBe(true);
    expect(gunzipSync(readFileSync(`${f}.3.gz`)).toString().startsWith("B")).toBe(true);
  });
  it("a writer holding an append fd keeps writing to the live file", async () => {
    const f = join(dir, "a.log"); writeFileSync(f, lines(200, "A"));
    const w = createWriteStream(f, { flags: "a" });
    await new Promise((r) => w.write("before\n", r));
    await rotateLog(f, 100, 3, 300);
    await new Promise((r) => w.write("after\n", r));
    await new Promise((r) => w.end(r));
    const live = readFileSync(f, "utf8");
    expect(live.endsWith("before\nafter\n")).toBe(true);
    expect(statSync(f).size).toBeLessThan(400);
  });
  it("rotateLogsIn uses maxMB", async () => {
    writeFileSync(join(dir, "daemon.log"), "x".repeat(2 * 1024 * 1024));
    writeFileSync(join(dir, "router.log"), "y\n");
    expect(await rotateLogsIn(dir, { maxMB: 1, keep: 2 })).toEqual(["daemon.log"]);
  });
});
