/**
 * Tests for the generic PAI_HOME resolver/migrator that daemon/config.ts,
 * workers/workers-config.ts and pai-files.ts all build on.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { paiHomeDir, paiHomePath, resolvePaiFile, migratePaiFile, PaiFileMigrationError } from "./pai-home.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-home-"));
  dirs.push(d);
  return d;
}

const savedPaiHome = process.env.PAI_HOME;
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
});

describe("paiHomeDir / paiHomePath", () => {
  it("PAI_HOME overrides the default namespace dir", () => {
    const dir = newDir();
    process.env.PAI_HOME = dir;
    expect(paiHomeDir()).toBe(dir);
    expect(paiHomePath("config.json")).toBe(join(dir, "config.json"));
  });
});

describe("resolvePaiFile", () => {
  it("returns the new path when it exists, ignoring old candidates", () => {
    const dir = newDir();
    const newPath = join(dir, "new.txt");
    const oldPath = join(dir, "old.txt");
    writeFileSync(newPath, "new", "utf8");
    writeFileSync(oldPath, "old", "utf8");
    expect(resolvePaiFile(newPath, [oldPath], "pai config migrate")).toBe(newPath);
  });

  it("falls back to the first existing old candidate, in order", () => {
    const dir = newDir();
    const newPath = join(dir, "new.txt");
    const old1 = join(dir, "old1.txt");
    const old2 = join(dir, "old2.txt");
    writeFileSync(old2, "older", "utf8");
    expect(resolvePaiFile(newPath, [old1, old2], "pai config migrate")).toBe(old2);

    writeFileSync(old1, "old", "utf8");
    expect(resolvePaiFile(newPath, [old1, old2], "pai config migrate")).toBe(old1);
  });

  it("returns the new path (a write target) when nothing exists anywhere", () => {
    const dir = newDir();
    const newPath = join(dir, "new.txt");
    const oldPath = join(dir, "old.txt");
    expect(resolvePaiFile(newPath, [oldPath], "pai config migrate")).toBe(newPath);
  });
});

describe("migratePaiFile", () => {
  it("copies the old file to the new path, verifies it, and renames the old one aside", () => {
    const dir = newDir();
    const newPath = join(dir, "new", "config.json");
    const oldPath = join(dir, "old.json");
    writeFileSync(oldPath, '{"a":1}', "utf8");

    const r = migratePaiFile(newPath, [oldPath]);
    expect(r.dryRun).toBe(false);
    expect(r.fromPath).toBe(oldPath);
    expect(r.toPath).toBe(newPath);
    expect(readFileSync(newPath, "utf8")).toBe('{"a":1}');

    expect(existsSync(oldPath)).toBe(false);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(existsSync(`${oldPath}.migrated-${stamp}`)).toBe(true);
  });

  it("--dry-run writes nothing", () => {
    const dir = newDir();
    const newPath = join(dir, "new.json");
    const oldPath = join(dir, "old.json");
    writeFileSync(oldPath, '{"a":1}', "utf8");

    const r = migratePaiFile(newPath, [oldPath], { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(existsSync(newPath)).toBe(false);
    expect(existsSync(oldPath)).toBe(true);
  });

  it("is a graceful no-op when nothing old or new exists", () => {
    const dir = newDir();
    const newPath = join(dir, "new.json");
    const oldPath = join(dir, "old.json");
    const r = migratePaiFile(newPath, [oldPath]);
    expect(r.fromPath).toBeNull();
    expect(r.note).toMatch(/nothing to migrate/);
  });

  it("is idempotent: an old file identical to an already-migrated new file is renamed aside without error", () => {
    const dir = newDir();
    const newPath = join(dir, "new.json");
    const oldPath = join(dir, "old.json");
    writeFileSync(newPath, '{"a":1}', "utf8");
    writeFileSync(oldPath, '{"a":1}', "utf8");

    const r = migratePaiFile(newPath, [oldPath]);
    expect(r.fromPath).toBe(oldPath);
    expect(r.note).toMatch(/identical/);
    expect(existsSync(oldPath)).toBe(false);
  });

  it("refuses to overwrite a new file that differs from the old one — nothing is lost", () => {
    const dir = newDir();
    const newPath = join(dir, "new.json");
    const oldPath = join(dir, "old.json");
    writeFileSync(newPath, '{"a":1}', "utf8");
    writeFileSync(oldPath, '{"a":2}', "utf8");

    expect(() => migratePaiFile(newPath, [oldPath])).toThrow(PaiFileMigrationError);
    expect(readFileSync(newPath, "utf8")).toBe('{"a":1}');
    expect(existsSync(oldPath)).toBe(true);
  });

  it("creates the destination directory if it doesn't exist yet", () => {
    const dir = newDir();
    const newPath = join(dir, "deep", "nested", "config.json");
    const oldPath = join(dir, "old.json");
    writeFileSync(oldPath, '{"a":1}', "utf8");
    mkdirSync(dirname(oldPath), { recursive: true });

    const r = migratePaiFile(newPath, [oldPath]);
    expect(existsSync(newPath)).toBe(true);
    expect(r.dryRun).toBe(false);
  });
});
