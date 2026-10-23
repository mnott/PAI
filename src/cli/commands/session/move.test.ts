import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "../../../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../../../storage/registry-sqlite.js";
import { moveSession } from "./move.js";

let dir: string;
let db: InstanceType<typeof DatabaseCtor>;
let backend: SQLiteRegistryBackend;

async function project(slug: string) {
  return backend.createProject({ slug, displayName: slug, rootPath: `/tmp/${slug}`, encodedDir: `-tmp-${slug}`, createdAt: 1, updatedAt: 1 });
}
async function session(projectId: number, number: number, title: string, cid: string) {
  const s = await backend.createSession({ projectId, number, date: "2026-10-14", slug: title, title, filename: `${number}.md`, createdAt: 1 });
  db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(cid, s.id);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-move-"));
  db = new DatabaseCtor(join(dir, "registry.db"));
  initializeSchema(db);
  backend = new SQLiteRegistryBackend(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("moveSession", () => {
  it("moves by prefix and renumbers into the target", async () => {
    const a = await project("a");
    const b = await project("b");
    const s = await session(a.id, 1, "Work", "cdd93e8d-1111");
    await session(b.id, 1, "Other", "ffff0000-2222");
    const r = await moveSession(backend, "cdd93e8d", "b");
    expect(r).toMatchObject({ id8: "cdd93e8d", title: "Work", from: "a", to: "b", number: 2 });
    const moved = await backend.getSessionById(s.id);
    expect(moved?.project_id).toBe(b.id);
    expect(moved?.number).toBe(2);
  });

  it("dry run changes nothing", async () => {
    const a = await project("a");
    await project("b");
    const s = await session(a.id, 1, "Work", "cdd93e8d-1111");
    await moveSession(backend, "cdd9", "b", true);
    expect((await backend.getSessionById(s.id))?.project_id).toBe(a.id);
  });

  it("lists candidates for an ambiguous prefix", async () => {
    const a = await project("a");
    await project("b");
    await session(a.id, 1, "One", "cdd93e8d-1");
    await session(a.id, 2, "Two", "cdd93e8d-2");
    await expect(moveSession(backend, "cdd9", "b")).rejects.toThrow(/Ambiguous(?=[\s\S]*One)(?=[\s\S]*Two)/);
  });

  it("errors on unknown session or project", async () => {
    const a = await project("a");
    await session(a.id, 1, "One", "cdd93e8d-1");
    await expect(moveSession(backend, "zzzz", "a")).rejects.toThrow(/No session/);
    await expect(moveSession(backend, "cdd9", "nope")).rejects.toThrow(/Project not found/);
    await expect(moveSession(backend, "cdd9", "a")).rejects.toThrow(/already belongs/);
  });
});
