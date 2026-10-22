import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restorePostgres, runRestore, type PgRunner } from "./restore.js";
import { planPostgresRestore, writeBackupMeta, readBackupMeta } from "./backup-postgres.js";

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-restore-target-"));
  tmps.push(d);
  return d;
}
afterEach(() => { vi.restoreAllMocks(); for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const DUMP = [
  "COPY public.pai_files (id) FROM stdin;", "1", "2", "\\.",
  "COPY public.sessions (id) FROM stdin;", "a", "\\.",
  "-- PostgreSQL database dump complete", "",
].join("\n");

const daemonPg = { database: "paidata", user: "paiuser" };
const pgCfg = { connectionString: "postgresql://paiuser:x@localhost:5432/paidata" };

describe("planPostgresRestore", () => {
  it("targets the daemon database and accepts a matching source", async () => {
    const p = planPostgresRestore(pgCfg, { database: "paidata", counts: {} });
    expect(p.target).toMatchObject(daemonPg);
    expect(p.refusal).toBeUndefined();
  });
  it("refuses a mismatching source", async () => {
    const p = planPostgresRestore(pgCfg, { database: "pai", counts: {} });
    expect(p.refusal).toMatch(/"pai".*"paidata"/);
  });
  it("refuses an unknown source and names the common fix", async () => {
    expect(planPostgresRestore(pgCfg, null).refusal).toMatch(/--into paidata/);
  });
  it("rejects --into names that are option-like or too long", async () => {
    expect(planPostgresRestore(pgCfg, null, "-x").refusal).toMatch(/invalid/);
    expect(planPostgresRestore(pgCfg, null, "a".repeat(40)).refusal).toMatch(/longer/);
  });
  it("honours --into over a mismatch", async () => {
    const p = planPostgresRestore(pgCfg, { database: "pai", counts: {} }, "scratch");
    expect(p.target.database).toBe("scratch");
    expect(p.refusal).toBeUndefined();
  });
  it("round-trips backup metadata", async () => {
    const d = tmpDir();
    writeBackupMeta(d, { database: "paidata", counts: { sessions: 1 } });
    expect(readBackupMeta(d)).toEqual({ database: "paidata", counts: { sessions: 1 } });
    expect(readBackupMeta(tmpDir())).toBeNull();
  });
});

function runner(countFor: (table: string) => string) {
  const calls: string[][] = [];
  const run: PgRunner = (args) => {
    calls.push(args);
    if (args[0] === "pg_dump") return { status: 0, stdout: DUMP, stderr: "" };
    const q = args[args.indexOf("-tAc") + 1];
    if (q) return { status: 0, stdout: countFor(q.replace('SELECT count(*) FROM ', "").replace(/"/g, "")), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("restorePostgres target and verification", () => {
  it("restores into the resolved target, not 'pai'", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), DUMP);
    const { calls, run } = runner((t) => (t === "pai_files" ? "2" : "1"));
    const r = await restorePostgres(join(d, "dump.sql"), d, daemonPg, run);
    expect(r.ok).toBe(true);
    const all = calls.map((c) => c.join(" ")).join("\n");
    expect(all).toMatch(/pg_dump -U paiuser paidata/);
    expect(all).toMatch(/RENAME TO "paidata";/);
    expect(all).not.toMatch(/ pai;| pai$/m);
    expect(r.counts).toEqual({ pai_files: { expected: 2, actual: 2 }, sessions: { expected: 1, actual: 1 } });
  });
  it("honours an --into target", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), DUMP);
    const { calls, run } = runner(() => "2");
    await restorePostgres(join(d, "dump.sql"), d, { database: "scratch", user: "paiuser" }, run, { pai_files: 2 });
    expect(calls.map((c) => c.join(" ")).join("\n")).toMatch(/RENAME TO "scratch";/);
  });
  it("reports a post-restore count mismatch as failure", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), DUMP);
    const { run } = runner(() => "0");
    const r = await restorePostgres(join(d, "dump.sql"), d, daemonPg, run);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/pai_files: expected 2, got 0/);
  });
});

describe("restorePostgres identifier safety", () => {
  const evil = "a\"; DROP DATABASE pai;--";
  it("quotes names so --into cannot inject SQL or fold case", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), DUMP);
    const { calls, run } = runner(() => "2");
    await restorePostgres(join(d, "dump.sql"), d, { database: evil, user: "paiuser" }, run, { pai_files: 2 });
    const sql = calls.filter((c) => c.includes("-c")).map((c) => c[c.indexOf("-c") + 1]!);
    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) expect(q.replace(/"(?:[^"]|"")*"/g, "")).not.toMatch(/DROP DATABASE pai/);
    expect(sql.join("\n")).toContain('"a""; DROP DATABASE pai;--"');
  });
  it("keeps a mixed-case name as written", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), DUMP);
    const { calls, run } = runner(() => "2");
    await restorePostgres(join(d, "dump.sql"), d, { database: "PAI", user: "paiuser" }, run, { pai_files: 2 });
    expect(calls.map((c) => c.join(" ")).join("\n")).toContain('ALTER DATABASE "PAI" RENAME TO');
  });
  it("refuses an option-like or over-long name before touching anything", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), DUMP);
    const { calls, run } = runner(() => "2");
    expect((await restorePostgres(join(d, "dump.sql"), d, { database: "-x", user: "paiuser" }, run)).ok).toBe(false);
    expect((await restorePostgres(join(d, "dump.sql"), d, { database: "a".repeat(40), user: "paiuser" }, run)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("runRestore --dry-run", () => {
  it("prints target and source and changes nothing", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "postgres-pai.sql"), DUMP);
    writeBackupMeta(d, { database: "othername", counts: {} });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => { errs.push(a.join(" ")); });
    await runRestore(d, { postgres: true, yes: false, dryRun: true });
    const text = out.join("\n");
    expect(text).toMatch(/Target database/);
    expect(text).toMatch(/Dump source database\s+othername/);
    expect(text).toMatch(/Dry run/);
    expect(errs.join("\n")).toMatch(/Refusing/);
    process.exitCode = 0;
  });
});
