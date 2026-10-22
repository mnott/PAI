import { describe, it, expect, afterEach, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initializeFederationSchema } from "../storage/sqlite/federation-schema.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import type { StorageBackend, VaultFileRow, VaultLinkRow } from "../storage/interface.js";
import { indexProjectWithBackend } from "./indexer/async.js";
import { indexVault } from "./vault/indexer.js";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pai-idx-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function sqliteBackend() {
  const db = new BetterSqlite3(":memory:");
  initializeFederationSchema(db);
  return new SQLiteBackend(db);
}

/** Minimal in-memory vault backend (SQLiteBackend has no vault support). */
function fakeVaultBackend() {
  const files = new Map<string, VaultFileRow>();
  const chunks = new Map<string, number>();
  const deleted: string[] = [];
  const batches: Array<{ sources: string[]; links: VaultLinkRow[] }> = [];
  const backend = {
    getVaultFile: async (p: string) => files.get(p) ?? null,
    deleteChunksForFile: async (_pid: number, p: string) => { chunks.delete(p); },
    insertChunks: async (rows: Array<{ path: string }>) => {
      for (const r of rows) chunks.set(r.path, (chunks.get(r.path) ?? 0) + 1);
    },
    upsertVaultFile: async (f: VaultFileRow) => { files.set(f.vaultPath, f); },
    deleteVaultFile: async (p: string) => { deleted.push(p); files.delete(p); },
    getAllVaultFilePaths: async () => [...files.keys()],
    deleteVaultAliases: async () => {},
    upsertVaultAliases: async () => {},
    replaceNameIndex: async () => {},
    replaceLinksForSources: async (sources: string[], links: VaultLinkRow[]) => {
      batches.push({ sources, links });
    },
    upsertVaultHealth: async () => {},
  };
  return { backend: backend as unknown as StorageBackend, files, chunks, deleted, batches };
}

describe("indexVault pruning", () => {
  it("removes chunks and vault rows for files deleted from the vault", async () => {
    const root = scratch();
    for (let i = 0; i < 10; i++) write(join(root, `n${i}.md`), `# N${i}\n\nbody ${i}\n`);
    const f = fakeVaultBackend();
    await indexVault(f.backend, 9, root);
    expect(f.files.size).toBe(10);

    rmSync(join(root, "n9.md"));
    await indexVault(f.backend, 9, root);
    expect(f.deleted).toEqual(["n9.md"]);
    expect(f.files.size).toBe(9);
    expect(f.chunks.has("n9.md")).toBe(false);
    expect(f.chunks.has("n0.md")).toBe(true);
  });

  it("skips pruning and warns when 50% of files look stale", async () => {
    const root = scratch();
    for (let i = 0; i < 10; i++) write(join(root, `n${i}.md`), `# N${i}\n\nbody ${i}\n`);
    const f = fakeVaultBackend();
    await indexVault(f.backend, 9, root);
    for (let i = 0; i < 5; i++) rmSync(join(root, `n${i}.md`));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await indexVault(f.backend, 9, root);
    expect(f.deleted).toEqual([]);
    expect(f.files.size).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("5 of 10");
  });

  it("prunes a mass delete when forcePrune is set", async () => {
    const root = scratch();
    for (let i = 0; i < 10; i++) write(join(root, `n${i}.md`), `# N${i}\n\nbody ${i}\n`);
    const f = fakeVaultBackend();
    await indexVault(f.backend, 9, root);
    for (let i = 0; i < 5; i++) rmSync(join(root, `n${i}.md`));
    await indexVault(f.backend, 9, root, { forcePrune: true });
    expect(f.deleted.length).toBe(5);
    expect(f.files.size).toBe(5);
  });

  it("does not prune when the vault is empty or the root is missing", async () => {
    const root = scratch();
    write(join(root, "a.md"), "# A\n\nalpha\n");
    const f = fakeVaultBackend();
    await indexVault(f.backend, 9, root);

    rmSync(join(root, "a.md"));
    await indexVault(f.backend, 9, root);
    await indexVault(f.backend, 9, join(root, "missing"));
    expect(f.deleted).toEqual([]);
    expect([...f.files.keys()]).toEqual(["a.md"]);
  });
});

describe("indexVault link batching", () => {
  it("passes each batch exactly the links of its own sources", async () => {
    const root = scratch();
    const n = 1100;
    for (let i = 0; i < n; i++) {
      write(join(root, `n${i}.md`), `# N${i}\n\n[[n${(i + 1) % n}]]\n`);
    }
    const f = fakeVaultBackend();
    await indexVault(f.backend, 9, root);
    expect(f.batches.length).toBe(3);
    let total = 0;
    for (const b of f.batches) {
      const set = new Set(b.sources);
      for (const l of b.links) expect(set.has(l.sourcePath)).toBe(true);
      total += b.links.length;
    }
    expect(total).toBe(n);
  }, 60_000);
});

describe("indexProjectWithBackend claude memory namespace", () => {
  it("keeps claude-project memory files apart from the project root's memory files", async () => {
    const base = scratch();
    const root = join(base, "root");
    const claudeProject = join(base, "claude-proj");
    write(join(root, "memory", "x.md"), "# root x\n\nroot content\n");
    write(join(claudeProject, "memory", "x.md"), "# claude x\n\nclaude content\n");
    mkdirSync(join(claudeProject, "Notes"), { recursive: true });

    const backend = sqliteBackend();
    const first = await indexProjectWithBackend(backend, 1, root, join(claudeProject, "Notes"));
    expect(first.filesProcessed).toBe(2);
    const paths = (await backend.getDistinctChunkPaths(1)).sort();
    expect(paths).toContain("memory/x.md");
    expect(paths).toContain(".claude-memory/memory/x.md");

    // Nothing changed: neither file may be re-indexed on the next run.
    const second = await indexProjectWithBackend(backend, 1, root, join(claudeProject, "Notes"));
    expect(second.filesProcessed).toBe(0);
    expect(second.filesSkipped).toBe(2);
  });
});

describe("indexProjectWithBackend title chunks", () => {
  it("only upserts ::title chunks when they are missing", async () => {
    const root = scratch();
    write(join(root, "Notes", "0001 - 2026-01-01 - First session.md"), "# s\n\nbody\n");
    const backend = sqliteBackend();
    const spy = vi.spyOn(backend, "insertChunks");
    await indexProjectWithBackend(backend, 1, root);
    const titleInserts = () =>
      spy.mock.calls.filter((c) => c[0].some((r) => r.path.endsWith("::title"))).length;
    expect(titleInserts()).toBe(1);
    await indexProjectWithBackend(backend, 1, root);
    expect(titleInserts()).toBe(1);
  });
});
