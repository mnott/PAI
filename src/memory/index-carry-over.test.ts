import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFederationSchema } from "../storage/sqlite/federation-schema.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { embedChunksWithBackend, indexAllWithBackend, indexFileWithBackend } from "./indexer/async.js";
import { rewriteWarning, readRewriteWarning } from "./indexer/rewrite-guard.js";
import type { EmbeddingBackend } from "./backends/types.js";

const configured = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock("./backends/index.js", () => ({ getConfiguredBackend: () => configured.backend }));

function fakeEmbedder(): EmbeddingBackend & { texts: string[] } {
  return {
    id: "fake", model: "m", dims: 4, maxTokens: 512, texts: [] as string[],
    async available() { return { ok: true, reason: "fine" }; },
    async embed(texts: string[]) { this.texts.push(...texts); return texts.map(() => new Float32Array([1, 0, 0, 0])); },
  } as EmbeddingBackend & { texts: string[] };
}

let dir: string;
let db: BetterSqlite3.Database;
let storage: SQLiteBackend;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-carry-"));
  process.env.PAI_HOME = join(dir, "home");
  db = new BetterSqlite3(":memory:");
  initializeFederationSchema(db);
  storage = new SQLiteBackend(db);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PAI_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const doc = (...sections: string[]) => sections.map((s, i) => `# Section ${i}\n\n${s}\n`).join("\n");
const vecCount = (pid: number) => (db.prepare("SELECT COUNT(*) n FROM memory_chunks WHERE project_id = ? AND embedding IS NOT NULL").get(pid) as { n: number }).n;

describe("index keeps vectors", () => {
  it("an unchanged file is not rewritten", async () => {
    writeFileSync(join(dir, "a.md"), doc("alpha text", "beta text"));
    expect(await indexFileWithBackend(storage, 1, dir, "a.md", "notes", "topic")).toBe(true);
    db.prepare("UPDATE memory_chunks SET embedding = x'00', updated_at = 111").run();
    expect(await indexFileWithBackend(storage, 1, dir, "a.md", "notes", "topic")).toBe(false);
    const rows = db.prepare("SELECT DISTINCT updated_at u FROM memory_chunks").all() as Array<{ u: number }>;
    expect(rows).toEqual([{ u: 111 }]);
    expect(vecCount(1)).toBeGreaterThan(0);
  });

  it("re-chunking a changed file keeps the vectors of identical text only", async () => {
    writeFileSync(join(dir, "a.md"), doc("alpha text", "beta text"));
    await indexFileWithBackend(storage, 1, dir, "a.md", "notes", "topic");
    db.prepare("UPDATE memory_chunks SET embedding = x'0000803f'").run();
    writeFileSync(join(dir, "a.md"), doc("alpha text", "beta text CHANGED"));
    expect(await indexFileWithBackend(storage, 1, dir, "a.md", "notes", "topic")).toBe(true);
    const rows = db.prepare("SELECT text, embedding e FROM memory_chunks ORDER BY start_line").all() as Array<{ text: string; e: Buffer | null }>;
    const kept = rows.filter((r) => r.e !== null).map((r) => r.text);
    expect(kept.some((t) => t.includes("alpha text"))).toBe(true);
    expect(rows.filter((r) => r.text.includes("CHANGED")).every((r) => r.e === null)).toBe(true);
  });

  it("the same file under a new project id gets the old vectors, and the embed pass copies instead of embedding", async () => {
    writeFileSync(join(dir, "a.md"), doc("alpha text", "beta text"));
    await indexFileWithBackend(storage, 1, dir, "a.md", "notes", "topic");
    db.prepare("UPDATE memory_chunks SET embedding = x'0000803f'").run();
    // registry rebuilt: the project now has a new id, its chunks and file rows start empty
    await indexFileWithBackend(storage, 2, dir, "a.md", "notes", "topic");
    expect(vecCount(2)).toBe(vecCount(1));
    // an orphan that was indexed before vectors were carried: the embed pass copies by text hash
    db.prepare("UPDATE memory_chunks SET embedding = NULL WHERE project_id = 2").run();
    const emb = fakeEmbedder();
    configured.backend = emb;
    await storage.setEmbeddingBinding({ backend: "fake", model: "m", dims: 4 });
    await embedChunksWithBackend(storage);
    expect(emb.texts).toEqual([]);
    expect(vecCount(2)).toBe(vecCount(1));
  });
});

describe("mass rewrite warning", () => {
  it("is raised above the limit and never below", () => {
    expect(rewriteWarning(100, 5000)).toBeNull();
    expect(rewriteWarning(900, 5000)).toBeNull();
    expect(rewriteWarning(1100, 5000, 20)?.percent).toBeCloseTo(22);
    expect(rewriteWarning(1100, 5000, 30)).toBeNull();
    expect(rewriteWarning(50, 100)).toBeNull(); // small install, first index
  });

  it("an index-all that rewrites everything logs and records it; a quiet one clears it", async () => {
    const root = join(dir, "proj");
    mkdirSync(join(root, "Notes"), { recursive: true });
    writeFileSync(join(root, "Notes", "0001 - 2026-01-01 - big.md"), doc(...Array.from({ length: 1200 }, (_, i) => `paragraph number ${i}`)));
    const registry = { listProjects: async () => [{ id: 1, root_path: root, claude_notes_dir: null, display_name: "p" }] } as never;
    await indexAllWithBackend(storage, registry);
    const w = readRewriteWarning(process.env.PAI_HOME!);
    expect(w?.percent).toBeGreaterThan(20);
    expect((process.stderr.write as unknown as { mock: { calls: string[][] } }).mock.calls.some((c) => String(c[0]).includes("WARNING index pass rewrote"))).toBe(true);
    await indexAllWithBackend(storage, registry);
    expect(existsSync(join(process.env.PAI_HOME!, "run-progress", "index-warning.json"))).toBe(false);
  });
});
