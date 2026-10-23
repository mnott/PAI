import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "./sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "./registry-sqlite.js";
import { renameSessionNote } from "../hooks/ts/lib/project-utils/session-notes.js";
import { drainRenameQueue, resolveSessionNote, repairProject } from "./session-note-registry.js";

let dir: string;
let db: InstanceType<typeof DatabaseCtor>;
let backend: SQLiteRegistryBackend;
let notes: string;
let queue: string;

const touch = (p: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "# x\n");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-reg-"));
  db = new DatabaseCtor(join(dir, "registry.db"));
  initializeSchema(db);
  backend = new SQLiteRegistryBackend(db);
  notes = join(dir, ".claude", "projects", "-tmp-proj", "Notes");
  queue = join(dir, "queue.jsonl");
  process.env.PAI_RENAME_QUEUE = queue;
});
afterEach(() => {
  delete process.env.PAI_RENAME_QUEUE;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(number: number, date: string, filename: string, title = "Old") {
  const p = (await backend.getProjectBySlug("proj")) ?? (await backend.createProject({ slug: "proj", displayName: "proj", rootPath: "/tmp/proj", encodedDir: "-tmp-proj", createdAt: 1, updatedAt: 1 }));
  return backend.createSession({ projectId: p.id, number, date, slug: "old", title, filename, createdAt: 1 });
}

describe("renameSessionNote -> registry", () => {
  it("queued rename updates the row's title and filename", async () => {
    const s = await seed(7, "2026-03-04", "2026/03/0007 - 2026-03-04 - Old.md");
    const old = join(notes, "2026", "03", "0007 - 2026-03-04 - Old.md");
    touch(old);
    const np = renameSessionNote(old, "better name");
    expect(existsSync(np)).toBe(true);
    const r = await drainRenameQueue(async () => backend, queue);
    expect(r.applied).toBe(1);
    const row = await backend.getSessionById(s.id);
    expect(row?.title).toBe("Better Name");
    expect(row?.filename).toBe("2026/03/0007 - 2026-03-04 - Better Name.md");
  });

  it("unreachable registry keeps the rename and the queue entry", async () => {
    const old = join(notes, "0008 - 2026-03-04 - Old.md");
    touch(old);
    const np = renameSessionNote(old, "x y");
    expect(existsSync(np)).toBe(true);
    const r = await drainRenameQueue(async () => { throw new Error("down"); }, queue);
    expect(r.kept).toBe(1);
    expect(readFileSync(queue, "utf8")).toContain("0008 - 2026-03-04 - X Y.md");
  });

  it("unwritable queue never fails the rename", () => {
    process.env.PAI_RENAME_QUEUE = join(dir, "file-not-dir", "q.jsonl");
    writeFileSync(join(dir, "file-not-dir"), "");
    const old = join(notes, "0009 - 2026-03-04 - Old.md");
    touch(old);
    expect(existsSync(renameSessionNote(old, "fine"))).toBe(true);
  });
});

describe("resolveSessionNote", () => {
  it("falls back: stored, YYYY/MM, .archive, number+date", () => {
    const row = { number: 3, date: "2026-05-06", filename: "0003 - 2026-05-06 - A.md" };
    touch(join(notes, "0003 - 2026-05-06 - A.md"));
    expect(resolveSessionNote(notes, row)).toBe(join(notes, row.filename));
    rmSync(join(notes, row.filename));
    touch(join(notes, "2026", "05", row.filename));
    expect(resolveSessionNote(notes, row)).toBe(join(notes, "2026", "05", row.filename));
    rmSync(join(notes, "2026"), { recursive: true });
    touch(join(notes, ".archive", "2026", "05", row.filename));
    expect(resolveSessionNote(notes, row)).toBe(join(notes, ".archive", "2026", "05", row.filename));
    rmSync(join(notes, ".archive"), { recursive: true });
    touch(join(notes, "2026", "05", "0003 - 2026-05-06 - Renamed.md"));
    expect(resolveSessionNote(notes, row)).toBe(join(notes, "2026", "05", "0003 - 2026-05-06 - Renamed.md"));
    rmSync(join(notes, "2026"), { recursive: true });
    expect(resolveSessionNote(notes, row)).toBeNull();
  });
});

describe("repairProject", () => {
  it("fixes stale rows, counts ambiguous and unmatched, never deletes", async () => {
    const stale = await seed(1, "2026-01-01", "0001 - 2026-01-01 - Old.md");
    await seed(2, "2026-01-02", "0002 - 2026-01-02 - Old.md");
    await seed(3, "2026-01-03", "0003 - 2026-01-03 - Gone.md");
    const ok = await seed(4, "2026-01-04", "0004 - 2026-01-04 - Fine.md");
    touch(join(notes, "2026", "01", "0001 - 2026-01-01 - New Title.md"));
    touch(join(notes, "2026", "01", "0002 - 2026-01-02 - A.md"));
    touch(join(notes, "2026", "01", "0002 - 2026-01-02 - B.md"));
    touch(join(notes, "0004 - 2026-01-04 - Fine.md"));
    const project = (await backend.getProjectBySlug("proj"))!;
    const dry = await repairProject(backend, project, [notes], true);
    expect(dry).toMatchObject({ rows: 4, resolved: 1, fixed: 1, ambiguous: 1, unmatched: 1 });
    expect((await backend.getSessionById(stale.id))?.title).toBe("Old");
    const real = await repairProject(backend, project, [notes], false);
    expect(real.fixed).toBe(1);
    const row = await backend.getSessionById(stale.id);
    expect(row?.title).toBe("New Title");
    expect(row?.filename).toBe("2026/01/0001 - 2026-01-01 - New Title.md");
    expect((await backend.getSessionById(ok.id))?.filename).toBe("0004 - 2026-01-04 - Fine.md");
    expect(await backend.listSessionsForProject(project.id)).toHaveLength(4);
  });
});
