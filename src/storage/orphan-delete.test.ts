import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { Pool } from "pg";

vi.mock("./foreign-config-guard.js", () => ({ assertDestructiveAllowed: () => undefined }));

import { PostgresRegistryBackend } from "./registry-postgres.js";

interface Chunk { id: string; project_id: number; path: string; hash: string; vec: boolean }
interface File { project_id: number; path: string; hash: string }

/** In-memory stand-in for the three tables, answering exactly the statements repair-orphans --delete issues. */
function fakePool(opts: { projects: number[]; chunks: Chunk[]; files: File[]; dropBackupRows?: boolean }) {
  const { projects, chunks, files } = opts;
  const sql: string[] = [];
  const currentHashes = (rows: { project_id: number; hash: string; vec?: boolean }[], needVec: boolean) =>
    new Set(rows.filter((r) => projects.includes(r.project_id) && (!needVec || r.vec)).map((r) => r.hash));
  const isTwinSql = (q: string) => q.includes("t.hash = pai_chunks.hash") || q.includes("hash IN (SELECT hash FROM pai_files");
  const chunkTwin = (c: Chunk) => currentHashes(chunks, true).has(c.hash);
  const fileTwin = (f: File) => currentHashes(files, false).has(f.hash);
  const match = (q: string, table: "pai_chunks" | "pai_files", id: number) => {
    const twin = isTwinSql(q);
    return table === "pai_chunks"
      ? chunks.filter((c) => c.project_id === id && (!twin || chunkTwin(c)))
      : files.filter((f) => f.project_id === id && (!twin || fileTwin(f)));
  };
  const group = (rows: { project_id: number }[]) => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(r.project_id, (m.get(r.project_id) ?? 0) + 1);
    return m;
  };
  const orphan = (r: { project_id: number }) => !projects.includes(r.project_id);

  const query = async (q: string, args: unknown[] = []) => {
    sql.push(q);
    if (q.includes("information_schema.tables")) return { rows: [], rowCount: 0 };
    if (q.includes("UNION ALL")) {
      const n = group(chunks.filter(orphan));
      const f = group(files.filter(orphan));
      const ids = new Set([...n.keys(), ...f.keys()]);
      return { rows: [...ids].map((id) => ({ project_id: id, n: String(n.get(id) ?? 0), f: String(f.get(id) ?? 0) })) };
    }
    if (q.startsWith("SELECT c.project_id, COUNT(*)")) {
      const ids = args[0] as number[];
      const m = group(chunks.filter((c) => ids.includes(c.project_id) && chunkTwin(c)));
      return { rows: [...m].map(([project_id, n]) => ({ project_id, n: String(n) })) };
    }
    if (q.startsWith("SELECT f.project_id, COUNT(*)")) {
      const ids = args[0] as number[];
      const m = group(files.filter((f) => ids.includes(f.project_id) && fileTwin(f)));
      return { rows: [...m].map(([project_id, n]) => ({ project_id, n: String(n) })) };
    }
    const page = q.match(/^SELECT (id|path) AS k, row_to_json\((pai_chunks|pai_files)\)/);
    if (page) {
      const table = page[2] as "pai_chunks" | "pai_files";
      const last = args[args.length - 1] as string;
      let rows = (match(q, table, args[0] as number) as (Chunk | File)[])
        .map((r) => ({ k: "id" in r ? r.id : r.path, j: JSON.stringify(r) }))
        .filter((r) => r.k > last)
        .sort((a, b) => (a.k < b.k ? -1 : 1));
      if (opts.dropBackupRows && table === "pai_chunks") rows = rows.slice(1);
      return { rows };
    }
    const del = q.match(/^DELETE FROM (pai_chunks|pai_files)/);
    if (del) {
      const table = del[1] as "pai_chunks" | "pai_files";
      const size = args[args.length - 1] as number;
      const hit = new Set(match(q, table, args[0] as number).slice(0, size));
      const store = (table === "pai_chunks" ? chunks : files) as unknown[];
      for (let i = store.length - 1; i >= 0; i--) if (hit.has(store[i] as never)) store.splice(i, 1);
      return { rows: [], rowCount: hit.size };
    }
    if (q.startsWith("SELECT COUNT(*) AS n FROM")) return { rows: [{ n: "0" }] };
    throw new Error(`fake pool: unexpected SQL ${q.slice(0, 80)}`);
  };
  const pool = Object.assign(Object.create(pg.Pool.prototype), { query, on: () => undefined }) as Pool;
  return { pool, sql, chunks, files };
}

const ch = (id: string, project_id: number, hash: string, vec = false): Chunk => ({ id, project_id, path: `${id}.md`, hash, vec });

describe("repair-orphans --delete: unmapped orphans", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orphan-delete-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const world = () => ({
    projects: [10],
    chunks: [
      ch("cur1", 10, "h1", true), ch("cur2", 10, "h2", true),
      ch("twin1", 5, "h1"), ch("twin2", 5, "h2"), ch("stale1", 5, "old"),
      ch("twin3", 6, "h1"),
    ],
    files: [
      { project_id: 10, path: "a.md", hash: "fa" },
      { project_id: 5, path: "a.md", hash: "fa" },
      { project_id: 5, path: "gone.md", hash: "fg" },
    ],
  });

  it("dry run counts twins and stale separately and changes nothing", async () => {
    const f = fakePool(world());
    const be = new PostgresRegistryBackend(f.pool);
    const r = await be.repairOrphans({ dryRun: true, deleteTwins: true, backupDir: dir });
    expect(r).toMatchObject({ unmappedIds: 2, unmappedTwinChunks: 3, unmappedStaleChunks: 1, deletedUnmappedChunks: 3, deletedUnmappedFiles: 1, backupFiles: [] });
    expect(f.chunks).toHaveLength(6);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("execute deletes the twins only, after writing a verified backup", async () => {
    const f = fakePool(world());
    const be = new PostgresRegistryBackend(f.pool);
    const r = await be.repairOrphans({ dryRun: false, deleteTwins: true, backupDir: dir });
    expect(r).toMatchObject({ deletedUnmappedChunks: 3, deletedUnmappedFiles: 1 });
    expect(f.chunks.map((c) => c.id).sort()).toEqual(["cur1", "cur2", "stale1"]);
    expect(f.files.map((x) => x.path + x.project_id).sort()).toEqual(["a.md10", "gone.md5"]);
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^orphans-\d+-chunks\.copy\.gz$/);
    expect(names[1]).toMatch(/^orphans-\d+-files\.copy\.gz$/);
    const rows = gunzipSync(readFileSync(join(dir, names[0]))).toString().trim().split("\n").map((l) => JSON.parse(l).id);
    expect(rows.sort()).toEqual(["twin1", "twin2", "twin3"]);
    // the backup existed before the first DELETE
    expect(f.sql.findIndex((q) => q.startsWith("DELETE"))).toBeGreaterThan(f.sql.findIndex((q) => q.includes("row_to_json")));
  });

  it("--include-stale also deletes the unmapped orphans without a twin", async () => {
    const f = fakePool(world());
    const be = new PostgresRegistryBackend(f.pool);
    const r = await be.repairOrphans({ dryRun: false, deleteTwins: true, includeStale: true, backupDir: dir });
    expect(r).toMatchObject({ deletedUnmappedChunks: 4, deletedUnmappedFiles: 2 });
    expect(f.chunks.map((c) => c.id).sort()).toEqual(["cur1", "cur2"]);
    expect(f.files).toHaveLength(1);
  });

  it("deletes in batches per old project id", async () => {
    const w = world();
    for (let i = 0; i < 25; i++) w.chunks.push(ch(`bulk${i}`, 7, "h1"));
    const f = fakePool(w);
    const log: string[] = [];
    const { runDelete } = await import("./orphan-delete.js");
    const out = await runDelete(f.pool, [{ oldId: 7, table: "pai_chunks", where: "project_id = $1", args: [7], expected: 25 }], {
      dryRun: false, backupDir: dir, ts: 1, batchSize: 10, log: (m) => log.push(m),
    });
    expect(out.deleted).toEqual([25]);
    expect(f.sql.filter((q) => q.startsWith("DELETE"))).toHaveLength(3);
    expect(log.filter((m) => m.startsWith("project 7"))).toHaveLength(3);
  });

  it("aborts without deleting when the backup row count differs from the plan", async () => {
    const f = fakePool({ ...world(), dropBackupRows: true });
    const be = new PostgresRegistryBackend(f.pool);
    await expect(be.repairOrphans({ dryRun: false, deleteTwins: true, backupDir: dir })).rejects.toThrow(/does not match.*nothing deleted/);
    expect(f.chunks).toHaveLength(6);
    expect(f.sql.some((q) => q.startsWith("DELETE"))).toBe(false);
  });
});
