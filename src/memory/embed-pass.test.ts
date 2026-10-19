import { describe, it, expect, vi, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { initializeFederationSchema } from "../storage/sqlite/federation-schema.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { embedChunksWithBackend } from "./indexer/async.js";
import { runEmbed } from "../cli/commands/memory/embed.js";
import { embedYieldReason, formatEmbedStatus } from "./embed-pass.js";
import type { EmbeddingBackend } from "./backends/types.js";

const configured = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock("./backends/index.js", () => ({ getConfiguredBackend: () => configured.backend }));

/** Fake embedder: each call takes `ms` of wall clock. */
function fakeEmbedder(ms: number): EmbeddingBackend & { calls: number } {
  return {
    id: "fake",
    model: "m",
    dims: 4,
    maxTokens: 512,
    calls: 0,
    async available() {
      return { ok: true, reason: "fine" };
    },
    async embed(texts) {
      this.calls++;
      await new Promise((r) => setTimeout(r, ms));
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  } as EmbeddingBackend & { calls: number };
}

function makeStorage(chunks: number) {
  const db = new BetterSqlite3(":memory:");
  initializeFederationSchema(db);
  const ins = db.prepare(
    "INSERT INTO memory_chunks (id, project_id, path, start_line, end_line, hash, text, updated_at, embedding) VALUES (?, 1, 'a.md', 1, 2, 'h', ?, 0, NULL)",
  );
  for (let i = 0; i < chunks; i++) ins.run(`c${String(i).padStart(4, "0")}`, `text ${i}`);
  return new SQLiteBackend(db);
}

afterEach(() => vi.restoreAllMocks());

describe("embed pass budget", () => {
  it("daemon pass stops at the time budget and reports it; the backlog stays countable", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const storage = makeStorage(200);
    const emb = fakeEmbedder(20);
    configured.backend = emb;
    let end: { outcome: string } | undefined;
    const n = await embedChunksWithBackend(storage, undefined, undefined, {
      maxMillis: 100,
      batchSize: 10,
      onEnd: (r) => { end = r; },
    });
    expect(end?.outcome).toBe("budget");
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(200);
    expect(await storage.countUnembeddedChunks()).toBe(200 - n);
  });

  it("a pass with room finishes as done", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const storage = makeStorage(30);
    configured.backend = fakeEmbedder(0);
    let end: { outcome: string } | undefined;
    await embedChunksWithBackend(storage, undefined, undefined, { batchSize: 10, onEnd: (r) => { end = r; } });
    expect(end?.outcome).toBe("done");
    expect(await storage.countUnembeddedChunks()).toBe(0);
  });

  it("hand-run embed stops at --max-minutes, unlimited without a budget", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = makeStorage(100);
    configured.backend = fakeEmbedder(20);
    const r = await runEmbed(storage, undefined, undefined, 10, 50, 80);
    expect(r.budgetHit).toBe(true);
    expect(r.done).toBeLessThan(100);
    const rest = await runEmbed(storage, undefined, undefined, 10, 50, undefined);
    expect(rest.budgetHit).toBe(false);
    expect(r.done + rest.done).toBe(100);
  });
});

describe("embed pass yield", () => {
  it("yields on high load or a busy local worker, not otherwise", () => {
    expect(embedYieldReason({ load: 2, maxLoad: 8, localBusy: false })).toBeNull();
    expect(embedYieldReason({ load: 9, maxLoad: 8, localBusy: false })).toMatch(/load average/);
    expect(embedYieldReason({ load: 1, maxLoad: 8, localBusy: true })).toMatch(/local-model/);
  });

  it("a pass that yields mid-way stops and leaves the rest", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const storage = makeStorage(60);
    const emb = fakeEmbedder(0);
    configured.backend = emb;
    let calls = 0;
    let end: { outcome: string; reason?: string } | undefined;
    const n = await embedChunksWithBackend(storage, undefined, undefined, {
      batchSize: 10,
      shouldYield: () => (++calls > 3 ? "local-model worker running" : null),
      onEnd: (r) => { end = r; },
    });
    expect(end).toMatchObject({ outcome: "yielded", reason: "local-model worker running" });
    expect(n).toBe(20);
    expect(await storage.countUnembeddedChunks()).toBe(40);
  });

  it("yielding before the start embeds nothing and never calls the embedder", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const storage = makeStorage(10);
    const emb = fakeEmbedder(0);
    configured.backend = emb;
    expect(await embedChunksWithBackend(storage, undefined, undefined, { shouldYield: () => "busy" })).toBe(0);
    expect(emb.calls).toBe(0);
  });
});

describe("status fields", () => {
  it("shows backlog and last pass", () => {
    expect(
      formatEmbedStatus({
        embedBacklog: 2773131,
        lastEmbedPass: { at: "2026-10-19T03:00:00Z", outcome: "budget", embedded: 16450 },
      }),
    ).toEqual([
      "Embed:       2773131 chunks without vectors",
      "Last embed:  budget hit, 16450 chunks at 2026-10-19T03:00:00Z",
    ]);
    expect(formatEmbedStatus({ lastEmbedPass: { at: "t", outcome: "yielded", embedded: 0, reason: "load average 9.0 above 8" } })[0])
      .toBe("Last embed:  yielded, 0 chunks at t (load average 9.0 above 8)");
    expect(formatEmbedStatus({})).toEqual([]);
  });
});
