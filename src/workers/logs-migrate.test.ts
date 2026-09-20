/**
 * Tests for the directory-level logDir migrator: it must refuse while a
 * spawned worker is RUNNING against the old directory, and otherwise behave
 * like migratePaiFile (copy, verify, rename the old dir aside — never
 * delete).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateWorkerLogs, activeSpawnedWorkerCount, WorkerLogsMigrationError } from "./logs-migrate.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-logs-migrate-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
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
    writeStatus(dir, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 3 });
    writeStatus(dir, "chat-1", { state: "running", origin: "chat", label: "unlabeled", turns: 0 });
    writeStatus(dir, "done-1", { state: "done", origin: "spawn", label: "task", turns: 5 });
    expect(activeSpawnedWorkerCount(dir)).toBe(1);
  });
});

describe("migrateWorkerLogs", () => {
  it("refuses while a spawned worker is RUNNING, leaving the old dir untouched", () => {
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 1 });

    expect(() => migrateWorkerLogs(oldPath, newPath)).toThrow(WorkerLogsMigrationError);
    expect(existsSync(newPath)).toBe(false);
    expect(existsSync(join(oldPath, "spawn-1.status"))).toBe(true);
  });

  it("--dry-run reports the plan without throwing, even while a worker is RUNNING", () => {
    const dir = newDir();
    const oldPath = join(dir, "old-logs");
    const newPath = join(dir, "new-logs");
    writeStatus(oldPath, "spawn-1", { state: "running", origin: "spawn", label: "task", turns: 1 });

    const r = migrateWorkerLogs(oldPath, newPath, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(existsSync(newPath)).toBe(false);
  });

  it("moves the whole tree when nothing is RUNNING, verifies the file count, and renames the old dir aside", () => {
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
