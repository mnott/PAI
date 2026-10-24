import { describe, it, expect } from "vitest";
import { runEmbedPipeline, type PipelineRow } from "./embed-pipeline.js";

const rows = (n: number, from = 0): PipelineRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, text: `t${from + i}` }));

const vec = (): Float32Array => new Float32Array(2);

/** Pages of `size` over `all`, resuming after the row given. */
function pager(all: PipelineRow[], size: number, log: string[] = []) {
  return async (last: PipelineRow | null): Promise<PipelineRow[]> => {
    const start = last ? all.findIndex((r) => r.id === last.id) + 1 : 0;
    log.push(`fetch@${start}`);
    return all.slice(start, start + size);
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe("runEmbedPipeline", () => {
  it("embeds and writes every row exactly once, in bulk batches", async () => {
    const all = rows(103);
    const written: string[][] = [];
    const r = await runEmbedPipeline({
      fetchPage: pager(all, 40),
      embed: async (t) => t.map(vec),
      write: async (b) => { written.push(b.map((x) => x.id)); },
      batchSize: 25,
      concurrency: 3,
    });
    expect(r).toEqual({ done: 103, end: "done" });
    expect(written.every((b) => b.length <= 25)).toBe(true);
    expect(written.flat().sort()).toEqual(all.map((x) => x.id).sort());
  });

  it("prefetches the next page while the current one is embedding", async () => {
    const log: string[] = [];
    let firstEmbedStarted = false;
    await runEmbedPipeline({
      fetchPage: pager(rows(60), 30, log),
      embed: async (t) => {
        if (!firstEmbedStarted) {
          firstEmbedStarted = true;
          await tick();
          log.push("first-embed-done");
        }
        return t.map(vec);
      },
      write: async () => {},
      batchSize: 30,
      concurrency: 1,
    });
    expect(log.indexOf("fetch@30")).toBeGreaterThan(-1);
    expect(log.indexOf("fetch@30")).toBeLessThan(log.indexOf("first-embed-done"));
  });

  it("runs up to `concurrency` embeds at once and no more", async () => {
    let live = 0;
    let peak = 0;
    await runEmbedPipeline({
      fetchPage: pager(rows(100), 100),
      embed: async (t) => {
        live++;
        peak = Math.max(peak, live);
        await tick();
        live--;
        return t.map(vec);
      },
      write: async () => {},
      batchSize: 10,
      concurrency: 3,
    });
    expect(peak).toBe(3);
  });

  it("writes a batch while another batch is still embedding", async () => {
    const events: string[] = [];
    let n = 0;
    await runEmbedPipeline({
      fetchPage: pager(rows(20), 20),
      embed: async (t) => {
        const me = n++;
        events.push(`embed${me}-start`);
        await new Promise<void>((r) => setTimeout(r, me === 0 ? 1 : 30));
        events.push(`embed${me}-end`);
        return t.map(vec);
      },
      write: async () => { events.push("write"); },
      batchSize: 10,
      concurrency: 2,
    });
    expect(events.indexOf("write")).toBeLessThan(events.indexOf("embed1-end"));
  });

  it("stops taking batches on stop, finishes the ones in flight and reports stopped", async () => {
    let stop = false;
    const written: string[] = [];
    const r = await runEmbedPipeline({
      fetchPage: pager(rows(100), 100),
      embed: async (t) => { stop = true; return t.map(vec); },
      write: async (b) => { written.push(...b.map((x) => x.id)); },
      batchSize: 10,
      concurrency: 1,
      shouldStop: () => stop,
    });
    expect(r.end).toBe("stopped");
    expect(r.done).toBe(10);
    expect(written).toHaveLength(10);
  });

  it("ends with budget once the deadline passes", async () => {
    let t = 0;
    const r = await runEmbedPipeline({
      fetchPage: pager(rows(100), 100),
      embed: async (x) => { t += 10; return x.map(vec); },
      write: async () => {},
      batchSize: 10,
      concurrency: 1,
      deadline: 25,
      now: () => t,
    });
    expect(r.end).toBe("budget");
    expect(r.done).toBe(30);
  });

  it("ends with yielded and the reason", async () => {
    let calls = 0;
    const r = await runEmbedPipeline({
      fetchPage: pager(rows(100), 100),
      embed: async (x) => x.map(vec),
      write: async () => {},
      batchSize: 10,
      concurrency: 1,
      shouldYield: () => (++calls > 2 ? "load average 9.0 above 8" : null),
    });
    expect(r).toEqual({ done: 20, end: "yielded", reason: "load average 9.0 above 8" });
  });

  it("rejects with the embed error and takes no further batch", async () => {
    let embeds = 0;
    await expect(
      runEmbedPipeline({
        fetchPage: pager(rows(100), 100),
        embed: async (x) => { embeds++; throw new Error("ollama down"); void x; },
        write: async () => {},
        batchSize: 10,
        concurrency: 2,
      }),
    ).rejects.toThrow("ollama down");
    expect(embeds).toBeLessThanOrEqual(2);
  });

  it("surfaces a prefetch failure", async () => {
    let page = 0;
    await expect(
      runEmbedPipeline({
        fetchPage: async () => { if (page++ === 1) throw new Error("db gone"); return rows(10); },
        embed: async (x) => x.map(vec),
        write: async () => {},
        batchSize: 10,
        concurrency: 1,
      }),
    ).rejects.toThrow("db gone");
  });
});

describe("StorageBackend.updateEmbeddings (SQLite)", () => {
  it("stores many vectors in one call and leaves other rows NULL", async () => {
    const { default: Db } = await import("better-sqlite3");
    const { initializeFederationSchema } = await import("../storage/sqlite/federation-schema.js");
    const { SQLiteBackend } = await import("../storage/sqlite.js");
    const db = new Db(":memory:");
    initializeFederationSchema(db);
    const ins = db.prepare(
      "INSERT INTO memory_chunks (id, project_id, path, start_line, end_line, hash, text, updated_at, embedding) VALUES (?, 1, 'a.md', 1, 2, 'h', 't', 0, NULL)",
    );
    for (const id of ["a", "b", "c"]) ins.run(id);
    const backend = new SQLiteBackend(db);
    await backend.updateEmbeddings([
      { id: "a", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
      { id: "b", embedding: Buffer.from(new Float32Array([0, 1]).buffer) },
    ]);
    expect(await backend.countUnembeddedChunks()).toBe(1);
    expect((await backend.getUnembeddedChunkIds()).map((r) => r.id)).toEqual(["c"]);
  });
});
