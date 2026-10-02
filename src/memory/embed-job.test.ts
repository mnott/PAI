import { describe, it, expect } from "vitest";
import { toBatches, recreateIndexSql, formatEta, vectorLiteral } from "./embed-job.js";

const DEF =
  "CREATE INDEX idx_pai_chunks_embedding ON public.pai_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64')";

describe("embed-job helpers", () => {
  it("batches and honours the limit", () => {
    const rows = Array.from({ length: 130 }, (_, i) => i);
    expect(toBatches(rows, 64).map((b) => b.length)).toEqual([64, 64, 2]);
    expect(toBatches(rows, 64, 70).map((b) => b.length)).toEqual([64, 6]);
    expect(toBatches([], 64)).toEqual([]);
  });

  it("round-trips the index definition, adding only IF NOT EXISTS", () => {
    const sql = recreateIndexSql("idx_pai_chunks_embedding", DEF);
    expect(sql).toBe(DEF.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "));
    expect(sql.replace(" IF NOT EXISTS", "")).toBe(DEF);
  });

  it("rejects a definition of another index", () => {
    expect(() => recreateIndexSql("idx_pai_chunks_embedding", DEF.replace("idx_pai_chunks_embedding", "other"))).toThrow();
    expect(() => recreateIndexSql("idx_pai_chunks_embedding", "DROP TABLE x")).toThrow();
  });

  it("formats eta and vectors", () => {
    expect(formatEta(3725)).toBe("1h2m");
    expect(formatEta(NaN)).toBe("?");
    expect(vectorLiteral(Float32Array.from([0.5, -1]))).toBe("[0.5,-1]");
  });
});
