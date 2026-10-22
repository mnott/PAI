import { describe, it, expect, vi, afterEach } from "vitest";
import type { Pool } from "pg";
import { searchKeyword, searchSemantic } from "./search.js";

/**
 * A failed search must not be indistinguishable from an empty one.
 *
 * Both functions used to catch, log to the daemon's stderr, and return [], so a
 * stopped backend looked like a genuine miss and a caller could wrongly conclude
 * that nothing was recorded.
 */

afterEach(() => vi.restoreAllMocks());

/** A pool whose queries fail the way a stopped container makes them fail. */
const deadPool = (): Pool =>
  ({
    query: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
  }) as unknown as Pool;

const emptyPool = (): Pool =>
  ({ query: () => Promise.resolve({ rows: [] }) }) as unknown as Pool;

describe("an unreachable backend throws", () => {
  it("keyword search rejects rather than returning []", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(searchKeyword(deadPool(), "dmarc")).rejects.toThrow(/unreachable/i);
  });

  it("semantic search rejects rather than returning []", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      searchSemantic(deadPool(), new Float32Array([0.1, 0.2]))
    ).rejects.toThrow(/unreachable/i);
  });

  it("says it is NOT an empty result set, and how to fix it", async () => {
    // The message is the whole point: whoever reads it must not conclude "nothing
    // is recorded".
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let message = "";
    try {
      await searchKeyword(deadPool(), "dmarc");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/NOT an empty result set/);
    expect(message).toMatch(/pai-pgvector/);
    expect(message).toContain("ECONNREFUSED");
  });

  it("still logs to the daemon's stderr, for the operator", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await searchKeyword(deadPool(), "dmarc").catch(() => undefined);
    expect(spy).toHaveBeenCalled();
  });
});

describe("a genuine miss is still a genuine miss", () => {
  it("returns [] when the backend answers with no rows", async () => {
    // The distinction only has value if the healthy-but-empty case stays quiet.
    await expect(searchKeyword(emptyPool(), "nothing matches this")).resolves.toEqual([]);
  });

  it("returns [] for a query that reduces to nothing, without touching the pool", async () => {
    const pool = {
      query: () => Promise.reject(new Error("should not be called")),
    } as unknown as Pool;
    await expect(searchKeyword(pool, "!!!")).resolves.toEqual([]);
  });
});

describe("searchKeyword result shape", () => {
  const rowsPool = (rows: unknown[]): Pool =>
    ({ query: () => Promise.resolve({ rows }) }) as unknown as Pool;
  const row = (rank: number) => ({
    id: "c1", project_id: 1, path: "a.md", start_line: 1, end_line: 2,
    snippet: "s", tier: "note", source: "project", updated_at: "1700000000000",
    last_accessed_at: null, rank_score: rank,
  });

  it("returns chunkId and numeric updatedAt", async () => {
    const [r] = await searchKeyword(rowsPool([row(0.5)]), "alpha");
    expect(r.chunkId).toBe("c1");
    expect(r.updatedAt).toBe(1700000000000);
  });

  it("honours minScore", async () => {
    const res = await searchKeyword(rowsPool([row(0.1), row(0.9)]), "alpha", { minScore: 0.5 });
    expect(res.map((r) => r.score)).toEqual([0.9]);
  });
});
