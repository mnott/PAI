import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StorageBackend } from "../../../storage/interface.js";

vi.mock("../../../memory/embeddings.js", () => ({
  serializeEmbedding: vi.fn((v: Float32Array) => Buffer.from(v.buffer)),
}));
vi.mock("../../../memory/embedding-gate.js", () => ({
  gateBackend: vi.fn(async () => ({
    ok: true,
    backend: { embed: async (texts: string[]) => texts.map(() => new Float32Array([1, 2, 3])) },
  })),
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

  const backend: Pick<StorageBackend, "getUnembeddedChunkIds" | "updateEmbedding" | "updateEmbeddings" | "getStats" | "getProjectStats" | "countUnembeddedChunks"> = {
    async getUnembeddedChunkIds(_projectId, limit, after) {
      const pending = rows.filter((r) => !r.embedded);
      const start = after ? pending.findIndex((r) => r.id > after.id) : 0;
      if (after && start < 0) return [];
      const page = pending.slice(Math.max(start, 0), Math.max(start, 0) + (limit ?? pending.length));
      maxRowsInFlight = Math.max(maxRowsInFlight, page.length);
      return page.map(({ id, text, project_id, path }) => ({ id, text, project_id, path }));
    },
    async updateEmbedding(chunkId) {
      const row = rows.find((r) => r.id === chunkId);
      if (row) row.embedded = true;
    },
    async updateEmbeddings(items) {
      for (const i of items) {
        const row = rows.find((r) => r.id === i.id);
        if (row) row.embedded = true;
      }
    },
    async countUnembeddedChunks() {
      return rows.filter((r) => !r.embedded).length;
    },
    async getStats() {
      // the index holds far more chunks than the backlog: progress must not use this number
      return { files: 1, chunks: rowCount * 20 };
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

describe("runEmbed progress and stop", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("counts progress against the backlog at start, not the index's total chunks", async () => {
    const { backend } = makeFakeBackend(300);
    const { runEmbed, embedProgressLine } = await import("./embed.js");
    const lines: string[] = [];
    (process.stdout.write as unknown as ReturnType<typeof vi.fn>).mockImplementation((s: string) => { lines.push(String(s)); return true; });
    const seen: Array<{ backlog?: number; done: number[] }> = [{ done: [] }];
    await runEmbed(backend, undefined, undefined, 50, 100, undefined, {
      setBacklog: (n) => { seen[0].backlog = n; },
      progress: (d) => seen[0].done.push(d),
      release: () => {},
    });
    expect(seen[0].backlog).toBe(300);
    expect(seen[0].done.at(-1)).toBe(300);
    expect(lines.join("")).toContain("300 / 300 chunks embedded...");
    expect(lines.join("")).not.toContain("6000");
    expect(embedProgressLine(14900, 122303)).toBe("14900 / 122303 chunks embedded...");
  });

  it("stops cleanly between batches when asked, leaving the rest for a re-run", async () => {
    const { backend, rows } = makeFakeBackend(300);
    const { runEmbed } = await import("./embed.js");
    let batches = 0;
    const r = await runEmbed(backend, undefined, undefined, 50, 100, undefined, undefined, () => ++batches > 2);
    expect(r.done).toBe(100);
    expect(rows.filter((x) => !x.embedded)).toHaveLength(200);
    // a re-run continues where it stopped
    const again = await runEmbed(backend, undefined, undefined, 50, 100);
    expect(again.done).toBe(200);
  });
});
