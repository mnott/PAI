import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { ensureIndexes, ENSURE_INDEX_LOCK_TIMEOUT } from "./ensure-index.js";

/** Fake pool: records every statement; pg_indexes answers from `existing`. */
function fakePool(existing: string[], failCreate?: Error) {
  const sql: string[] = [];
  const run = async (text: string, params?: unknown[]) => {
    sql.push(text);
    if (text.includes("pg_indexes")) {
      const hit = existing.includes(params?.[0] as string);
      return { rowCount: hit ? 1 : 0, rows: hit ? [{}] : [] };
    }
    if (failCreate && text.startsWith("CREATE INDEX")) throw failCreate;
    return { rowCount: 0, rows: [] };
  };
  const release = vi.fn();
  const pool = { query: run, connect: async () => ({ query: run, release }) } as unknown as Pool;
  return { pool, sql, release };
}

const spec = { name: "idx_pc_hash_embedded", table: "pai_chunks", columns: "hash", where: "embedding IS NOT NULL" };

describe("ensureIndexes", () => {
  it("issues no CREATE when the index already exists", async () => {
    const { pool, sql } = fakePool(["idx_pc_hash_embedded"]);
    await ensureIndexes(pool, [spec]);
    expect(sql.some((s) => s.includes("CREATE INDEX"))).toBe(false);
    expect(sql.some((s) => s.includes("lock_timeout"))).toBe(false);
  });

  it("creates a missing index CONCURRENTLY under a short lock_timeout", async () => {
    const { pool, sql, release } = fakePool([]);
    await ensureIndexes(pool, [spec]);
    const lt = sql.findIndex((s) => s.includes(`SET lock_timeout = '${ENSURE_INDEX_LOCK_TIMEOUT}'`));
    const create = sql.findIndex((s) => s.startsWith("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pc_hash_embedded ON pai_chunks(hash) WHERE embedding IS NOT NULL"));
    expect(lt).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(lt);
    expect(sql).toContain("RESET lock_timeout");
    expect(release).toHaveBeenCalledOnce();
  });

  it("logs a lock timeout and continues with the next index", async () => {
    const err = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    const { pool, sql, release } = fakePool([], err);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(ensureIndexes(pool, [spec, { ...spec, name: "idx_other" }])).resolves.toBeUndefined();
      const logged = write.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain("idx_pc_hash_embedded not ensured");
      expect(logged).toContain("lock timeout");
    } finally {
      write.mockRestore();
    }
    expect(sql.filter((s) => s.startsWith("CREATE INDEX")).length).toBe(2);
    expect(sql.some((s) => s.startsWith("DROP INDEX CONCURRENTLY IF EXISTS idx_pc_hash_embedded"))).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
