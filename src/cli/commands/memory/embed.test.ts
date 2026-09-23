import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StorageBackend } from "../../../storage/interface.js";

vi.mock("../../../memory/embeddings.js", () => ({
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 2, 3]))),
  serializeEmbedding: vi.fn((v: Float32Array) => Buffer.from(v.buffer)),
}));

/** Fake backend backed by an in-memory row set, paginating exactly like the real backends. */
function makeFakeBackend(rowCount: number) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: String(i).padStart(6, "0"),
    text: `chunk ${i}`,
    project_id: 1,
    path: "notes.md",
    embedded: false,
  }));

  let maxRowsInFlight = 0;

  const backend: Pick<StorageBackend, "getUnembeddedChunkIds" | "updateEmbedding" | "getStats" | "getProjectStats"> = {
    async getUnembeddedChunkIds(_projectId, limit, after) {
      const pending = rows.filter((r) => !r.embedded);
      const start = after ? pending.findIndex((r) => r.id > after.id) : 0;
      const page = pending.slice(Math.max(start, 0), Math.max(start, 0) + (limit ?? pending.length));
      maxRowsInFlight = Math.max(maxRowsInFlight, page.length);
      return page.map(({ id, text, project_id, path }) => ({ id, text, project_id, path }));
    },
    async updateEmbedding(chunkId) {
      const row = rows.find((r) => r.id === chunkId);
      if (row) row.embedded = true;
    },
    async getStats() {
      return { files: 1, chunks: rowCount };
    },
    async getProjectStats() {
      return { files: 1, chunks: rowCount };
    },
  };

  return { backend: backend as StorageBackend, rows, getMaxRowsInFlight: () => maxRowsInFlight };
}

describe("runEmbed pagination", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("embeds every row exactly once while never holding more than one page in memory", async () => {
    const { backend, rows, getMaxRowsInFlight } = makeFakeBackend(10_000);
    const { runEmbed } = await import("./embed.js");

    await runEmbed(backend, undefined, undefined, 50, 100);

    expect(rows.every((r) => r.embedded)).toBe(true);
    expect(getMaxRowsInFlight()).toBeLessThanOrEqual(100);
  });
});
