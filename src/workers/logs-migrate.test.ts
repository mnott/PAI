/**
 * Tests for the directory-level logDir migrator: the normal path is an
 * atomic renameSync plus a symlink left at the old path; only the EXDEV
 * fallback (copy + verify + rename-aside, never delete) needs to refuse
 * while a spawned worker is RUNNING against the old directory.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateWorkerLogs, activeSpawnedWorkerCount, WorkerLogsMigrationError } from "./logs-migrate.js";

const state = vi.hoisted(() => ({ forceExdev: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (oldPath: string, newPath: string) => {
      if (state.forceExdev && !String(newPath).includes(".migrated-")) {
        const e = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
        e.code = "EXDEV";
        throw e;
      }
      return actual.renameSync(oldPath, newPath);
    },
  };
});

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-logs-migrate-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  state.forceExdev = false;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeStatus(logDir: string, id: string, fields: Record<string, unknown>): void {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${id}.status`), JSON.stringify({ id, ...fields }), "utf8");
}

describe("activeSpawnedWorkerCount", () => {
  it("is 0 for an empty or missing logDir", () => {
    const dir = newDir();
    expect(activeSpawnedWorkerCount(join(dir, "nope"))).toBe(0);
  });

  it("counts RUNNING spawned workers but not the interactive chat pane", () => {
    const dir = newDir();
    writeStatus(dir, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 3, pid: process.pid });
    writeStatus(dir, "chat-1", { state: "running", origin: "chat", label: "unlabeled", turns: 0, pid: process.pid });
    writeStatus(dir, "done-1", { state: "done", origin: "spawn", label: "task", turns: 5, pid: process.pid });
    expect(activeSpawnedWorkerCount(dir)).toBe(1);
  });

  it("does not count a RUNNING status whose pid is dead (stale, process long gone)", () => {
    const dir = newDir();
    // pid 999999 is never our own and, on any sane machine, not alive.
    writeStatus(dir, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 3, pid: 999999 });
    expect(activeSpawnedWorkerCount(dir)).toBe(0);
  });
});

describe("migrateWorkerLogs — same-volume rename (normal case)", () => {
  it("renames the tree atomically and leaves a symlink at the old path", () => {
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "done-1", { state: "done", origin: "spawn", label: "task", turns: 5 });
    mkdirSync(join(oldPath, "panes"), { recursive: true });
    writeFileSync(join(oldPath, "panes", "w1t1.json"), "{}", "utf8");

    const r = migrateWorkerLogs(oldPath, newPath);
    expect(r.dryRun).toBe(false);
    expect(r.filesMoved).toBe(2);
    expect(readFileSync(join(newPath, "done-1.status"), "utf8")).toContain("done-1");
    expect(readFileSync(join(newPath, "panes", "w1t1.json"), "utf8")).toBe("{}");

    expect(lstatSync(oldPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(oldPath)).toBe(newPath);
  });

  it("does not block on a stale/live RUNNING status — no fallback guard on the rename path", () => {
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 1, pid: process.pid });

    expect(() => migrateWorkerLogs(oldPath, newPath)).not.toThrow();
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(true);
  });

  it("a file appended via the old path after migration lands in the new dir", () => {
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "done-1", { state: "done", origin: "spawn", label: "task", turns: 5 });

    migrateWorkerLogs(oldPath, newPath);
    appendFileSync(join(oldPath, "late.jsonl"), "line\n", "utf8");

    expect(readFileSync(join(newPath, "late.jsonl"), "utf8")).toBe("line\n");
  });
});

describe("migrateWorkerLogs — EXDEV fallback (copy + verify + rename-aside)", () => {
  it("does not block on a stale RUNNING status with a dead pid", () => {
    state.forceExdev = true;
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 1, pid: 999999 });

    const r = migrateWorkerLogs(oldPath, newPath);
    expect(r.dryRun).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(existsSync(`${oldPath}.migrated-${stamp}`)).toBe(true);
  });

  it("refuses while a live spawned worker is RUNNING, leaving the old dir untouched", () => {
    state.forceExdev = true;
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 1, pid: process.pid });

    expect(() => migrateWorkerLogs(oldPath, newPath)).toThrow(WorkerLogsMigrationError);
    expect(existsSync(newPath)).toBe(false);
    expect(existsSync(join(oldPath, "spawn-1.status"))).toBe(true);
  });

  it("--dry-run reports the plan without throwing, even while a worker is RUNNING", () => {
    state.forceExdev = true;
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 1, pid: process.pid });

    const r = migrateWorkerLogs(oldPath, newPath, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(existsSync(newPath)).toBe(false);
  });

  it("copies the whole tree when nothing is RUNNING, verifies the file count, and renames the old dir aside", () => {
    state.forceExdev = true;
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "done-1", { state: "done", origin: "spawn", label: "task", turns: 5 });
    mkdirSync(join(oldPath, "panes"), { recursive: true });
    writeFileSync(join(oldPath, "panes", "w1t1.json"), "{}", "utf8");

    const r = migrateWorkerLogs(oldPath, newPath);
    expect(r.dryRun).toBe(false);
    expect(r.filesMoved).toBe(2);
    expect(readFileSync(join(newPath, "done-1.status"), "utf8")).toContain("done-1");
    expect(readFileSync(join(newPath, "panes", "w1t1.json"), "utf8")).toBe("{}");

    expect(existsSync(oldPath)).toBe(false);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(existsSync(`${oldPath}.migrated-${stamp}`)).toBe(true);
    expect(existsSync(join(`${oldPath}.migrated-${stamp}`, "done-1.status"))).toBe(true);
  });
});

describe("migrateWorkerLogs — shared guards", () => {
  it("is a graceful no-op when the old logDir does not exist", () => {
    const dir = newDir();
    const r = migrateWorkerLogs(join(dir, "nope"), join(dir, "new-logs"));
    expect(r.fromPath).toBeNull();
    expect(r.note).toMatch(/nothing to migrate/);
  });

  it("refuses to overwrite an already-existing new logDir", () => {
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "done-1", { state: "done", origin: "spawn", label: "task", turns: 5 });
    mkdirSync(newPath, { recursive: true });

    const r = migrateWorkerLogs(oldPath, newPath);
    expect(r.note).toMatch(/already at new location/);
    expect(existsSync(oldPath)).toBe(true);
  });
});
