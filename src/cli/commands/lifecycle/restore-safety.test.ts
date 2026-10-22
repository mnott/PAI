import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreConfigWithSafety, restorePostgres, type PgRunner } from "./restore.js";

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-restore-safe-"));
  tmps.push(d);
  return d;
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("restoreConfigWithSafety", () => {
  it("keeps the current config in a 0600 timestamped file", () => {
    const d = tmpDir();
    writeFileSync(join(d, "old.json"), '{"v":"backup"}');
    writeFileSync(join(d, "config.json"), '{"v":"current"}');
    const safety = restoreConfigWithSafety(join(d, "old.json"), join(d, "config.json"));
    expect(safety).toMatch(/config\.json\.pre-restore-/);
    expect(readFileSync(safety!, "utf8")).toBe('{"v":"current"}');
    expect(statSync(safety!).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(d, "config.json"), "utf8")).toBe('{"v":"backup"}');
  });
});

const GOOD = "CREATE TABLE a();\n-- PostgreSQL database dump complete\n";
interface Call { args: string[]; input?: string }

function stub(overrides: (args: string[]) => { status: number; stderr?: string; stdout?: string } | undefined = () => undefined) {
  const calls: Call[] = [];
  const run: PgRunner = (args, input) => {
    calls.push({ args, input });
    const o = overrides(args);
    if (o) return { status: o.status, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
    if (args[0] === "pg_dump") return { status: 0, stdout: GOOD, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}
const sqlOf = (c: Call[]) => c.map((x) => x.args.join(" "));

describe("restorePostgres", () => {
  it("rejects a truncated dump before touching the database", () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), "CREATE TABLE a();\nINSERT INTO");
    const { calls, run } = stub();
    const r = restorePostgres(join(d, "dump.sql"), d, run);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty dump", () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), "");
    const { calls, run } = stub();
    expect(restorePostgres(join(d, "dump.sql"), d, run).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never drops the live database when psql fails; staging db is removed", () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), GOOD);
    const { calls, run } = stub((a) => (a.includes("ON_ERROR_STOP=1") ? { status: 3, stderr: "boom" } : undefined));
    const r = restorePostgres(join(d, "dump.sql"), d, run);
    expect(r.ok).toBe(false);
    const all = sqlOf(calls).join("\n");
    expect(all).not.toMatch(/DROP DATABASE IF EXISTS pai;/);
    expect(all).not.toMatch(/RENAME/);
    expect(all).toMatch(/DROP DATABASE IF EXISTS pai_restore_/);
    expect(readdirSync(d).some((f) => f.startsWith("postgres-pai.pre-restore-"))).toBe(true);
  });

  it("aborts without changes when the pre-restore dump fails", () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), GOOD);
    const { calls, run } = stub((a) => (a[0] === "pg_dump" ? { status: 1, stderr: "connection refused" } : undefined));
    expect(restorePostgres(join(d, "dump.sql"), d, run).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("restores into a new db and swaps by rename on success", () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), GOOD);
    const { calls, run } = stub();
    const r = restorePostgres(join(d, "dump.sql"), d, run);
    expect(r.ok).toBe(true);
    expect(r.oldDb).toMatch(/^pai_prerestore_/);
    const all = sqlOf(calls).join("\n");
    expect(all).toMatch(/RENAME TO pai_prerestore_/);
    expect(all).toMatch(/pai_restore_\w+ RENAME TO pai;/);
    expect(all).not.toMatch(/DROP DATABASE IF EXISTS pai;/);
  });

  it("leaves the live db when the rename is refused", () => {
    const d = tmpDir();
    writeFileSync(join(d, "dump.sql"), GOOD);
    const { run } = stub((a) => (a.join(" ").includes("RENAME TO pai_prerestore_") ? { status: 1, stderr: "being accessed by other users" } : undefined));
    const r = restorePostgres(join(d, "dump.sql"), d, run);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/live database untouched/);
  });
});
