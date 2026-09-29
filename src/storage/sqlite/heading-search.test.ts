import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFederationSchema } from "./federation-schema.js";
import { indexAllSqlite } from "./indexer.js";
import { searchMemory } from "./search.js";
import type { RegistryBackend } from "../registry-interface.js";

describe("heading breadcrumb reaches keyword search", () => {
  it("finds a section body by a word that appears only in a parent heading", async () => {
    const root = mkdtempSync(join(tmpdir(), "pai-heading-"));
    const db = new BetterSqlite3(":memory:");
    try {
      mkdirSync(join(root, "memory"));
      writeFileSync(
        join(root, "memory", "notes.md"),
        "# Decisions\n\n## Worker routing\n\n" + Array.from({ length: 150 }, (_, i) => `filler${i}`).join(" ") + "\n\n### Provider choice\n\nThe glm provider handles cheap probes; opus stays for review.\n",
      );
      initializeFederationSchema(db);
      const registry = {
        listProjects: async () => [{ id: 1, root_path: root, claude_notes_dir: null }],
      } as unknown as RegistryBackend;
      await indexAllSqlite(db, registry);

      const hits = searchMemory(db, "routing");
      console.log("query 'routing' ->", hits.length, "hit(s)", hits.map((h) => h.snippet));
      const body = hits.find((h) => h.snippet.includes("cheap probes"));
      expect(body).toBeDefined();
      expect(body!.snippet).toContain("[Decisions > Worker routing > Provider choice]");
      expect(body!.startLine).toBe(7);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
