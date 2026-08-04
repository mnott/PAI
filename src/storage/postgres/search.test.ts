import { describe, it, expect, vi, afterEach } from "vitest";
import type { Pool } from "pg";
import { searchKeyword, searchSemantic } from "./search.js";

/**
 * A failed search must not be indistinguishable from an empty one.
 *
 * Both functions used to catch, log to the daemon's stderr, and return []. On
 * 2026-08-04 `pai-pgvector` exited at 13:39Z with the index inside it, and for two
 * hours every memory_search returned cleanly empty. A sibling session searched for
 * an open DMARC point, got nothing, and told Matthias nothing was recorded — a
 * wrong answer that nothing in the response could have exposed.
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
    // is recorded", which is exactly the wrong conclusion drawn on 2026-08-04.
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
