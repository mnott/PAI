import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPostgres, configDatabaseMismatch, countDumpRows, resolveBackupTarget, type PgRunner } from "./backup-postgres.js";
import { isContainerTarget } from "../../../storage/postgres/config.js";

const DONE = "-- PostgreSQL database dump complete\n";
const DUMP = [
  "COPY public.pai_files (id) FROM stdin;",
  "1",
  "2",
  "\\.",
  "COPY public.sessions (id) FROM stdin;",
  "a",
  "\\.",
  DONE,
].join("\n");

const T = { database: "pai_alice", user: "pai" };

/** Runner whose counts are what the snapshot saw, independent of any later live state. */
function runner(dump: string, snapshotCounts: Record<string, number | null>, seen: unknown[] = []): PgRunner {
  return {
    async dump(target, dest) {
      seen.push(target);
      writeFileSync(dest, dump);
      return snapshotCounts;
    },
  };
}

const dest = () => join(mkdtempSync(join(tmpdir(), "pai-bk-")), "x.sql");

describe("backup database choice", () => {
  it("uses the daemon's per-user database, not the bare default", () => {
    const cfg = { connectionString: "postgresql://pai:pai@localhost:5432/pai_alice" };
    expect(resolveBackupTarget(cfg)).toMatchObject({ database: "pai_alice", user: "pai", host: "localhost", port: 5432 });
  });
  it("keeps the external server of the connection string and routes it away from the container", () => {
    const t = resolveBackupTarget({ connectionString: "postgresql://u:p%40w@db.example:6543/pai" });
    expect(t).toMatchObject({ host: "db.example", port: 6543, password: "p@w" });
    expect(isContainerTarget(t)).toBe(false);
    expect(isContainerTarget(resolveBackupTarget({}))).toBe(true);
    expect(isContainerTarget(resolveBackupTarget({ connectionString: "postgresql://u:p@[::1]:5432/pai" }))).toBe(true);
  });
  it("rejects a database name that would be an option or too long", () => {
    expect(() => resolveBackupTarget({ connectionString: "postgresql://u:p@h/-x" })).toThrow(/invalid/);
    expect(() => resolveBackupTarget({ connectionString: `postgresql://u:p@h/${"a".repeat(64)}` })).toThrow(/longer/);
  });
});

describe("backup self-check", () => {
  it("counts COPY rows", () => {
    expect(Object.fromEntries(countDumpRows(DUMP))).toEqual({ pai_files: 2, sessions: 1 });
  });
  it("passes when counts match", async () => {
    const r = await backupPostgres(T, dest(), runner(DUMP, { pai_files: 2, sessions: 1 }));
    expect(r.counts).toEqual({ pai_files: 2, sessions: 1 });
  });
  it("verifies against the dump's own snapshot, not later live counts (drift)", async () => {
    // the runner reports snapshot counts; later live drift cannot reach the check
    const r = await backupPostgres(T, dest(), runner(DUMP, { pai_files: 2, sessions: 1, pai_chunks: null }));
    expect(r.counts).toEqual({ pai_files: 2, sessions: 1 });
  });
  it("passes on a fresh install: empty tables emit no COPY block", async () => {
    const p = dest();
    const r = await backupPostgres(T, p, runner("CREATE TABLE a();\n" + DONE, { pai_files: 0, sessions: 0 }));
    expect(r.counts).toEqual({ pai_files: 0, sessions: 0 });
    expect(existsSync(p)).toBe(true);
  });
  it("fails on an empty/truncated dump, naming the database, and removes it", async () => {
    const p = dest();
    await expect(backupPostgres(T, p, runner("-- empty\n", { pai_files: 5 }))).rejects.toThrow(/pai_alice.*truncated/);
    expect(existsSync(p)).toBe(false);
  });
  it("fails on a count mismatch and removes the dump", async () => {
    const p = dest();
    await expect(backupPostgres(T, p, runner(DUMP, { pai_files: 3, sessions: 1 }))).rejects.toThrow(/pai_alice.*pai_files: dump 2, live 3/);
    expect(existsSync(p)).toBe(false);
  });
  it("removes a partial dump when pg_dump fails", async () => {
    const p = dest();
    const failing: PgRunner = { async dump(_t, d) { writeFileSync(d, "partial"); throw new Error("boom"); } };
    await expect(backupPostgres(T, p, failing)).rejects.toThrow(/boom/);
    expect(existsSync(p)).toBe(false);
  });
  it("fails when none of the main tables exist", async () => {
    await expect(backupPostgres(T, dest(), runner(DONE, { pai_files: null }))).rejects.toThrow(/none of the main tables/);
  });
  it("hands the runner the full target (external host)", async () => {
    const seen: unknown[] = [];
    const ext = resolveBackupTarget({ connectionString: "postgresql://u:p@db.example:5432/pai" });
    await backupPostgres(ext, dest(), runner(DUMP, { pai_files: 2, sessions: 1 }, seen));
    expect(seen[0]).toMatchObject({ host: "db.example" });
  });
});

describe("config mismatch after restore", () => {
  it("reports a backup config.json naming another database", () => {
    const d = mkdtempSync(join(tmpdir(), "pai-bk-"));
    const f = join(d, "config.json");
    writeFileSync(f, JSON.stringify({ postgres: { connectionString: "postgresql://u:p@localhost/pai" } }));
    expect(configDatabaseMismatch(f, { database: "pai2" })).toMatch(/"pai".*"pai2"/);
    expect(configDatabaseMismatch(f, { database: "pai" })).toBeNull();
  });
});
