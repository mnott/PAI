import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFederationSchema } from "./federation-schema.js";
import { indexAllSqlite } from "./indexer.js";
import { fileContentHash, CHUNKER_VERSION } from "../../memory/chunker.js";
import type { RegistryBackend } from "../registry-interface.js";

describe("chunker version invalidates the index", () => {
  it("fileContentHash changes with the version", () => {
    expect(fileContentHash("x", CHUNKER_VERSION)).not.toBe(fileContentHash("x", CHUNKER_VERSION + 1));
  });

  it("re-chunks a file exactly once after a version change", async () => {
    const root = mkdtempSync(join(tmpdir(), "pai-chunkver-"));
    const db = new BetterSqlite3(":memory:");
    try {
      mkdirSync(join(root, "memory"));
      const file = join(root, "memory", "a.md");
      writeFileSync(file, "# Title\n\nSome body text.\n");
      initializeFederationSchema(db);
      const registry = {
        listProjects: async () => [{ id: 1, root_path: root, claude_notes_dir: null }],
      } as unknown as RegistryBackend;

      const first = await indexAllSqlite(db, registry);
      const second = await indexAllSqlite(db, registry);
      expect(first.result.filesProcessed).toBe(1);
      expect(second.result.filesProcessed).toBe(0);
      expect(second.result.filesSkipped).toBe(1);

      // Simulate an index written by an older chunker version.
      db.prepare("UPDATE memory_files SET hash = ?").run(
        fileContentHash(readFileSync(file, "utf8"), CHUNKER_VERSION - 1),
      );
      const third = await indexAllSqlite(db, registry);
      const fourth = await indexAllSqlite(db, registry);
      expect(third.result.filesProcessed).toBe(1);
      expect(fourth.result.filesProcessed).toBe(0);
      expect(fourth.result.filesSkipped).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
