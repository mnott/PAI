import { describe, it, expect, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { initializeFederationSchema } from "../storage/sqlite/federation-schema.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { embedQuery, gateBackend } from "./embedding-gate.js";
import { reembedIndex } from "./reembed.js";
import { embedChunksWithBackend } from "./indexer/async.js";
import type { EmbeddingBackend } from "./backends/types.js";

// The embed pass resolves the configured backend; pin it to a controllable fake.
const configured = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock("./backends/index.js", () => ({ getConfiguredBackend: () => configured.backend }));

function fake(id: string, opts: { ok?: boolean; model?: string } = {}): EmbeddingBackend & { embedded: string[][] } {
  const embedded: string[][] = [];
  return {
    id,
    model: opts.model ?? "m",
    dims: 4,
    maxTokens: 512,
    embedded,
    async available() {
      return { ok: opts.ok ?? true, reason: opts.ok === false ? "server down" : "fine" };
    },
    async embed(texts) {
      embedded.push(texts);
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  };
}

function makeStorage(chunks: number, embeddedVec = false) {
  const db = new BetterSqlite3(":memory:");
  initializeFederationSchema(db);
  const ins = db.prepare(
    "INSERT INTO memory_chunks (id, project_id, path, start_line, end_line, hash, text, updated_at, embedding) VALUES (?, 1, 'a.md', 1, 2, 'h', ?, 0, ?)",
  );
  for (let i = 0; i < chunks; i++) ins.run(`c${i}`, `text ${i}`, embeddedVec ? Buffer.from([1, 2, 3, 4]) : null);
  return { db, storage: new SQLiteBackend(db) };
}

const embeddedCount = (db: BetterSqlite3.Database) =>
  (db.prepare("SELECT COUNT(*) n FROM memory_chunks WHERE embedding IS NOT NULL").get() as { n: number }).n;

describe("index binding", () => {
  it("an empty index has no binding; the first embed records it", async () => {
    const { storage } = makeStorage(3);
    expect(await storage.getEmbeddingBinding()).toBeNull();
    const b = fake("ollama-f16", { model: "mm" });
    expect((await gateBackend(storage, { record: true, backend: b })).ok).toBe(true);
    expect(await storage.getEmbeddingBinding()).toEqual({ backend: "ollama-f16", model: "mm", dims: 4 });
  });

  it("an index with vectors and no binding is legacy transformers-cpu-q8", async () => {
    const { storage } = makeStorage(2, true);
    expect(await storage.getEmbeddingBinding()).toMatchObject({ backend: "transformers-cpu-q8" });
    expect((await gateBackend(storage, { record: true, backend: fake("transformers-cpu-q8") })).ok).toBe(true);
    expect(await storage.getEmbeddingBinding()).toEqual({ backend: "transformers-cpu-q8", model: "m", dims: 4 });
  });

  it("mismatch blocks embedding: the backend is never called, binding untouched", async () => {
    const { storage } = makeStorage(3, true);
    const ollama = fake("ollama-f16");
    const gate = await gateBackend(storage, { record: true, backend: ollama });
    expect(gate).toMatchObject({ ok: false, kind: "mismatch" });
    expect((gate as { reason: string }).reason).toMatch(/index embedded with transformers-cpu-q8, configured ollama-f16.*pai memory reembed/);
    expect(ollama.embedded).toEqual([]);
    expect(await storage.getEmbeddingBinding()).toMatchObject({ backend: "transformers-cpu-q8" });
  });

  it("mismatch makes the query keyword-only: no embedding call, note returned", async () => {
    const { storage } = makeStorage(1, true);
    const ollama = fake("ollama-f16");
    const q = await embedQuery(storage, "hello", ollama);
    expect(q.vec).toBeNull();
    expect(q.note).toMatch(/pai memory reembed.*keyword-only/);
    expect(ollama.embedded).toEqual([]);
  });

  it("a matching backend embeds the prefixed query", async () => {
    const { storage } = makeStorage(1, true);
    const b = fake("transformers-cpu-q8");
    const q = await embedQuery(storage, "hello", b);
    expect(q.vec).toHaveLength(4);
    expect(b.embedded[0][0]).toMatch(/^Represent this sentence.*hello$/);
  });
});

describe("unavailable backend", () => {
  it("pauses embedding (no writes, no binding) and queries go keyword-only; nothing else is tried", async () => {
    const { db, storage } = makeStorage(5);
    const down = fake("ollama-f16", { ok: false });
    const gate = await gateBackend(storage, { record: true, backend: down });
    expect(gate).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await storage.getEmbeddingBinding()).toBeNull();
    const q = await embedQuery(storage, "x", down);
    expect(q.vec).toBeNull();
    expect(q.note).toMatch(/server down.*keyword-only/);
    expect(down.embedded).toEqual([]);
    expect(embeddedCount(db)).toBe(0);
  });
});

describe("embed pass wiring", () => {
  it("embedChunksWithBackend embeds with the configured backend and binds the index", async () => {
    const { db, storage } = makeStorage(3);
    const b = fake("ollama-f16");
    configured.backend = b;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await embedChunksWithBackend(storage)).toBe(3);
    expect(embeddedCount(db)).toBe(3);
    expect(await storage.getEmbeddingBinding()).toMatchObject({ backend: "ollama-f16" });
  });

  it("pauses (0 embedded, chunks stay NULL) on mismatch and when the backend is down", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const a = makeStorage(3, true);
    a.db.prepare("UPDATE memory_chunks SET embedding = NULL WHERE id = 'c0'").run();
    const ollama = fake("ollama-f16");
    configured.backend = ollama;
    expect(await embedChunksWithBackend(a.storage)).toBe(0);
    expect(ollama.embedded).toEqual([]);

    const b = makeStorage(3);
    const down = fake("ollama-f16", { ok: false });
    configured.backend = down;
    expect(await embedChunksWithBackend(b.storage)).toBe(0);
    expect(down.embedded).toEqual([]);
    expect(embeddedCount(b.db)).toBe(0);
  });
});

describe("reembed", () => {
  it("clears all vectors in bounded batches, then records the binding", async () => {
    const { db, storage } = makeStorage(25, true);
    const sizes: number[] = [];
    const orig = storage.clearEmbeddingsBatch.bind(storage);
    storage.clearEmbeddingsBatch = async (n) => {
      sizes.push(n);
      return orig(n);
    };
    const progress: number[] = [];
    const cleared = await reembedIndex(storage, fake("ollama-f16", { model: "mm" }), { batchSize: 10, onBatch: (n) => progress.push(n) });
    expect(cleared).toBe(25);
    expect(progress).toEqual([10, 20, 25]);
    expect(sizes).toEqual([10, 10, 10, 10]); // 3 productive batches + the terminating empty one
    expect(embeddedCount(db)).toBe(0);
    expect(await storage.getEmbeddingBinding()).toEqual({ backend: "ollama-f16", model: "mm", dims: 4 });
  });

  it("is resumable: an interrupted clear keeps the old binding and a re-run finishes", async () => {
    const { db, storage } = makeStorage(12, true);
    await storage.clearEmbeddingsBatch(5); // simulated crash after one batch
    expect(embeddedCount(db)).toBe(7);
    expect(await storage.getEmbeddingBinding()).toMatchObject({ backend: "transformers-cpu-q8" });
    await reembedIndex(storage, fake("ollama-f16"), { batchSize: 5 });
    expect(embeddedCount(db)).toBe(0);
    expect((await gateBackend(storage, { record: true, backend: fake("ollama-f16") })).ok).toBe(true);
  });
});
