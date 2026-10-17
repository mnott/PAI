import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdUnregister } from "./unregister.js";
import { getRegistryBackend, closeStorage, __resetStorageForTests } from "../../../storage/factory.js";
import type { SQLiteRegistryBackend } from "../../../storage/registry-sqlite.js";

/**
 * Removing a row that should never have existed.
 *
 * This DELETES, so the two properties worth defending are that it refuses when
 * sessions would be stranded, and that it does not leave rows behind in the four
 * other tables that reference a project — `PRAGMA foreign_keys` is 0 here, so
 * SQLite will not complain about any it misses.
 */

let paiHome: string;
let originalPaiHome: string | undefined;
let out: string[];

async function project(slug: string, path: string): Promise<number> {
  const backend = (await getRegistryBackend()) as SQLiteRegistryBackend;
  return Number(
    backend
      .getRawDb()
      .prepare(
        `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'local', 'active', 0, 0)`
      )
      .run(slug, slug, path, path.replace(/\//g, "-")).lastInsertRowid
  );
}

beforeEach(async () => {
  paiHome = mkdtempSync(join(tmpdir(), "pai-unreg-home-"));
  originalPaiHome = process.env.PAI_HOME;
  process.env.PAI_HOME = paiHome;
  __resetStorageForTests();
  out = [];
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeStorage();
  if (originalPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = originalPaiHome;
  rmSync(paiHome, { recursive: true, force: true });
  process.exitCode = undefined;
});

// cmdUnregister sets process.exitCode and returns normally on refusal — it no
// longer calls process.exit() (see src/cli/lib/exit.ts for why: exit() can
// truncate output still in flight to a pipe).
const call = (slug: string, opts: Parameters<typeof cmdUnregister>[1]) => cmdUnregister(slug, opts);

async function countProjects(): Promise<number> {
  const backend = await getRegistryBackend();
  return backend.countProjects();
}

describe("refusing", () => {
  it("refuses a row that holds sessions, and points at merge instead", async () => {
    const id = await project("wt", "/p/.claude/worktrees/wt");
    const backend = (await getRegistryBackend()) as SQLiteRegistryBackend;
    backend
      .getRawDb()
      .prepare(
        `INSERT INTO sessions (project_id, number, date, slug, title, filename, created_at)
         VALUES (?, 1, '2026-08-04', 's', 's', 's.md', 0)`
      )
      .run(id);

    await call("wt", { execute: true });

    expect(process.exitCode).toBe(1);
    expect(out.join("\n")).toContain("pai project merge");
    // The row must still be there — refusing has to mean refusing.
    expect(await countProjects()).toBe(1);
  });

  it("exits non-zero for an unknown slug", async () => {
    await call("ghost", { execute: true });
    expect(process.exitCode).toBe(1);
  });

  it("changes nothing without --execute", async () => {
    await project("t", "/private/tmp");
    await call("t", {});
    expect(await countProjects()).toBe(1);
    expect(out.join("\n")).toContain("Preview");
  });
});

describe("removing", () => {
  it("removes a zero-session row", async () => {
    await project("t", "/private/tmp");
    await call("t", { execute: true });
    expect(await countProjects()).toBe(0);
  });

  it("leaves nothing behind in any of the five tables", async () => {
    const id = await project("wt", "/p/.claude/worktrees/wt");
    const backend = (await getRegistryBackend()) as SQLiteRegistryBackend;
    const db = backend.getRawDb();
    const s = Number(
      db
        .prepare(
          `INSERT INTO sessions (project_id, number, date, slug, title, filename, created_at)
           VALUES (?, 1, '2026-08-04', 's', 's', 's.md', 0)`
        )
        .run(id).lastInsertRowid
    );
    const tag = Number(db.prepare("INSERT INTO tags (name) VALUES ('t')").run().lastInsertRowid);
    db.prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)").run(id, tag);
    db.prepare("INSERT INTO aliases (alias, project_id) VALUES ('a', ?)").run(id);
    db.prepare(
      `INSERT INTO compaction_log (project_id, session_id, trigger, files_written, created_at)
       VALUES (?, ?, 'manual', 'x', 0)`
    ).run(id, s);
    db.prepare(
      "INSERT INTO links (session_id, target_project_id, created_at) VALUES (?, ?, 0)"
    ).run(s, id);

    await call("wt", { execute: true, force: true });

    for (const [table, column] of [
      ["sessions", "project_id"],
      ["project_tags", "project_id"],
      ["aliases", "project_id"],
      ["compaction_log", "project_id"],
      ["links", "target_project_id"],
    ] as const) {
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id),
        table
      ).toEqual({ n: 0 });
    }
    expect(await countProjects()).toBe(0);
  });

  it("--force is required to take the sessions with it", async () => {
    // Deleting sessions is the one genuinely lossy thing here, so it must not be
    // reachable from --execute alone.
    const id = await project("wt", "/private/tmp/x");
    const backend = (await getRegistryBackend()) as SQLiteRegistryBackend;
    const db = backend.getRawDb();
    db.prepare(
      `INSERT INTO sessions (project_id, number, date, slug, title, filename, created_at)
       VALUES (?, 1, '2026-08-04', 's', 's', 's.md', 0)`
    ).run(id);

    await call("wt", { execute: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });

    await call("wt", { execute: true, force: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
});
