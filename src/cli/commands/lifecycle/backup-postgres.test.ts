import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPostgres, countDumpRows, resolveBackupTarget, type PgRunner } from "./backup-postgres.js";

const DUMP = [
  "COPY public.pai_files (id) FROM stdin;",
  "1",
  "2",
  "\\.",
  "COPY public.sessions (id) FROM stdin;",
  "a",
  "\\.",
].join("\n");

function runner(dump: string, live: Record<string, number>, seen: string[] = []): PgRunner {
  return {
    dump(db, _user, dest) {
      seen.push(db);
      writeFileSync(dest, dump);
    },
    count: (_db, _user, t) => live[t] ?? null,
  };
}

const dest = () => join(mkdtempSync(join(tmpdir(), "pai-bk-")), "x.sql");

describe("backup database choice", () => {
  it("uses the daemon's per-user database, not the bare default", () => {
    const cfg = { connectionString: "postgresql://pai:pai@localhost:5432/pai_alice" };
    expect(resolveBackupTarget(cfg)).toEqual({ database: "pai_alice", user: "pai" });
  });
});

describe("backup self-check", () => {
  it("counts COPY rows", () => {
    expect(Object.fromEntries(countDumpRows(DUMP))).toEqual({ pai_files: 2, sessions: 1 });
  });
  it("passes when counts match", () => {
    const r = backupPostgres({ database: "pai_alice", user: "pai" }, dest(), runner(DUMP, { pai_files: 2, sessions: 1 }));
    expect(r.counts).toEqual({ pai_files: 2, sessions: 1 });
  });
  it("fails on an empty dump, naming the database", () => {
    expect(() =>
      backupPostgres({ database: "pai_alice", user: "pai" }, dest(), runner("-- empty\n", { pai_files: 5 })),
    ).toThrow(/pai_alice.*no table data/);
  });
  it("fails on a count mismatch", () => {
    expect(() =>
      backupPostgres({ database: "pai_alice", user: "pai" }, dest(), runner(DUMP, { pai_files: 3, sessions: 1 })),
    ).toThrow(/pai_alice.*pai_files: dump 2, live 3/);
  });
});
