import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRunLock, RunLockedError, withRunLock } from "./run-lock.js";

const lockFile = (): string => join(mkdtempSync(join(tmpdir(), "runlock-")), "plan.yaml.lock");

describe("withRunLock", () => {
  it("refuses a second start while the pid is alive", async () => {
    const f = lockFile();
    writeFileSync(f, JSON.stringify({ pid: 4242, startedAt: new Date(2026, 0, 1, 9, 5).getTime() }));
    await expect(withRunLock(f, "plan x", async () => 1, { pid: 1, isAlive: () => true })).rejects.toThrow("a run of plan x is already in progress since 09:05");
    await expect(withRunLock(f, "plan x", async () => 1, { pid: 1, isAlive: () => true })).rejects.toBeInstanceOf(RunLockedError);
  });
  it("takes over a stale lock and removes it on exit", async () => {
    const f = lockFile();
    writeFileSync(f, JSON.stringify({ pid: 4242, startedAt: 1 }));
    const seen = await withRunLock(f, "plan x", async () => JSON.parse(readFileSync(f, "utf8")), { pid: 77, isAlive: () => false });
    expect(seen.pid).toBe(77);
    expect(existsSync(f)).toBe(false);
  });
  it("removes the lock when the run throws", async () => {
    const f = lockFile();
    await expect(withRunLock(f, "p", async () => { throw new Error("boom"); }, { pid: 5 })).rejects.toThrow("boom");
    expect(existsSync(f)).toBe(false);
  });
  it("readRunLock ignores dead pids", () => {
    const f = lockFile();
    writeFileSync(f, JSON.stringify({ pid: 9, startedAt: 1 }));
    expect(readRunLock(f, () => true)?.pid).toBe(9);
    expect(readRunLock(f, () => false)).toBeNull();
  });
});
