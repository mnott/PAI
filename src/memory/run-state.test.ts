import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRun, processStartMs, readRun, runStateFile } from "./run-state.js";

const home = (): string => mkdtempSync(join(tmpdir(), "run-state-"));

describe("acquireRun", () => {
  it("records the pid start time with the marker", () => {
    const h = home();
    const run = acquireRun("embed", { home: h });
    expect(run).not.toBeNull();
    const m = JSON.parse(readFileSync(runStateFile(h), "utf8"));
    expect(m.pid).toBe(process.pid);
    expect(m.pidStart).toBe(processStartMs(process.pid));
    run?.release();
    rmSync(h, { recursive: true });
  });

  it("a start that finds another start in progress gets null and leaves the marker alone", () => {
    const h = home();
    mkdirSync(join(h, "state"), { recursive: true });
    mkdirSync(`${runStateFile(h)}.lock`);
    expect(acquireRun("embed", { home: h })).toBeNull();
    expect(existsSync(runStateFile(h))).toBe(false);
    rmSync(h, { recursive: true });
  });

  it("a lock left by a dead start is cleared", () => {
    const h = home();
    mkdirSync(join(h, "state"), { recursive: true });
    const lock = `${runStateFile(h)}.lock`;
    mkdirSync(lock);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    const run = acquireRun("index", { home: h });
    expect(run).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
    run?.release();
    rmSync(h, { recursive: true });
  });

  it("readRun reports a live run of another pid", () => {
    const h = home();
    mkdirSync(join(h, "state"), { recursive: true });
    const other = process.pid + 1;
    writeFileSync(runStateFile(h), JSON.stringify({ kind: "embed", pid: other, by: "cli", startedAt: "", backlogStart: null, done: 0, updatedAt: "", jobId: "" }));
    expect(readRun(h, () => true)?.pid).toBe(other);
    rmSync(h, { recursive: true });
  });
});

describe("readRun identity", () => {
  const marker = (pid: number, pidStart?: number) =>
    JSON.stringify({ kind: "embed", pid, by: "cockpit", startedAt: "", backlogStart: null, done: 0, updatedAt: "", jobId: "", ...(pidStart !== undefined ? { pidStart } : {}) });

  it("a live pid with a different start time is a reused pid: no run", () => {
    const h = home();
    mkdirSync(join(h, "state"), { recursive: true });
    writeFileSync(runStateFile(h), marker(4242, 1_000_000));
    expect(readRun(h, () => true, () => 9_000_000)).toBeNull();
    rmSync(h, { recursive: true });
  });

  it("a live pid with the recorded start time is the run", () => {
    const h = home();
    mkdirSync(join(h, "state"), { recursive: true });
    writeFileSync(runStateFile(h), marker(4242, 1_000_000));
    expect(readRun(h, () => true, () => 1_000_500)?.pid).toBe(4242);
    rmSync(h, { recursive: true });
  });

  it("a marker without a start time (older run) is trusted on the live pid alone", () => {
    const h = home();
    mkdirSync(join(h, "state"), { recursive: true });
    writeFileSync(runStateFile(h), marker(4242));
    expect(readRun(h, () => true, () => undefined)?.pid).toBe(4242);
    rmSync(h, { recursive: true });
  });
});
