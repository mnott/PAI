import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { checkpointWal, verifyIntegrity } from "./legacy-migration.js";

const tmps: string[] = [];
const origPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = origPath;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function walDb(): { dir: string; path: string; live: BetterSqlite3.Database } {
  const dir = mkdtempSync(join(tmpdir(), "pai-legacy-"));
  tmps.push(dir);
  const path = join(dir, "registry.db");
  const live = new BetterSqlite3(path);
  live.pragma("journal_mode = WAL");
  live.pragma("wal_autocheckpoint = 0");
  live.exec("CREATE TABLE t (v TEXT)");
  live.prepare("INSERT INTO t VALUES (?)").run("wal-only");
  return { dir, path, live };
}

describe("legacy migration WAL handling", () => {
  it("checkpoints an uncheckpointed WAL with no sqlite3 on PATH; rows land in the main file", () => {
    const { path, live } = walDb();
    expect(existsSync(`${path}-wal`)).toBe(true);
    process.env.PATH = "/nonexistent";
    checkpointWal(path, "registry database");
    live.close();
    const main = new BetterSqlite3(path, { readonly: true });
    expect(main.prepare("SELECT v FROM t").all()).toEqual([{ v: "wal-only" }]);
    main.close();
    verifyIntegrity(path);
  });

  it("never moves a non-empty WAL away when the checkpoint cannot complete", () => {
    const { path, live } = walDb();
    // a second connection mid-read blocks the TRUNCATE checkpoint (busy)
    const reader = new BetterSqlite3(path);
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM t").all();
    live.prepare("INSERT INTO t VALUES (?)").run("more");
    expect(() => checkpointWal(path, "registry database")).toThrow(/non-empty WAL/);
    expect(existsSync(`${path}-wal`)).toBe(true);
    reader.close();
    live.close();
  });
});
