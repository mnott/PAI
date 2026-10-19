import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "../../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../../storage/registry-sqlite.js";
import { filesWrittenCount, resetFilesWrittenCount, writeIfChanged } from "./write-if-changed.js";
import { generateIndex, generateTopicPages } from "./generate.js";
import { generateMasterNotes, fixSessionTags } from "./master.js";
import { syncVault } from "./symlinks.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-wic-"));
  resetFilesWrittenCount();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeIfChanged", () => {
  it("does not rewrite identical content", () => {
    const f = join(dir, "a.md");
    expect(writeIfChanged(f, "x\n")).toBe(true);
    const mtime = statSync(f).mtimeMs;
    expect(writeIfChanged(f, "x\n")).toBe(false);
    expect(statSync(f).mtimeMs).toBe(mtime);
    expect(writeIfChanged(f, "y\n")).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("y\n");
    expect(filesWrittenCount()).toBe(2);
  });
});

describe("full vault sync", () => {
  it("writes nothing on the second run", async () => {
    const root = join(dir, "demo");
    const vault = join(dir, "vault");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "Notes"));
    writeFileSync(join(root, "Notes", "PAI.md"), '---\npai:\n  slug: "demo"\n---\n');
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(root, "Notes", `000${i} - 2026-10-0${i} - n.md`), `# Session ${i}\n\nbody ${i}\n\n**Tags:** #Session #demo\n`);
    }
    const db = new DatabaseCtor(":memory:");
    initializeSchema(db);
    const backend = new SQLiteRegistryBackend(db);
    const ts = Date.now();
    await backend.createProject({
      slug: "demo", displayName: "Demo", rootPath: root, encodedDir: "enc-demo",
      type: "local", status: "active", createdAt: ts, updatedAt: ts,
    });

    const run = async () => {
      await syncVault(vault, backend);
      await generateIndex(vault, backend);
      await generateTopicPages(vault, backend);
      await fixSessionTags(backend);
      await generateMasterNotes(vault, backend, 5);
    };
    await run();
    expect(filesWrittenCount()).toBeGreaterThan(0);
    resetFilesWrittenCount();
    await run();
    expect(filesWrittenCount()).toBe(0);
    db.close();
  });
});
