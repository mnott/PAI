import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { initializeSchema } from "../../../registry/schema.js";
import { cmdUnregister } from "./unregister.js";

/**
 * Removing a row that should never have existed.
 *
 * This DELETES, so the two properties worth defending are that it refuses when
 * sessions would be stranded, and that it does not leave rows behind in the four
 * other tables that reference a project — `PRAGMA foreign_keys` is 0 here, so
 * SQLite will not complain about any it misses.
 */

let dir: string;
let db: Database;
let out: string[];
let exited: number | undefined;

function project(slug: string, path: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'local', 'active', 0, 0)`
      )
      .run(slug, slug, path, path.replace(/\//g, "-")).lastInsertRowid
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-unreg-"));
  db = new DatabaseCtor(join(dir, "r.db"));
  initializeSchema(db);
  out = [];
  exited = undefined;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    exited = c ?? 0;
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (slug: string, opts: Parameters<typeof cmdUnregister>[2]) => {
  try {
    cmdUnregister(db, slug, opts);
  } catch (e) {
    if ((e as Error).message !== "exit") throw e;
  }
};

describe("refusing", () => {
  it("refuses a row that holds sessions, and points at merge instead", () => {
    const id = project("wt", "/p/.claude/worktrees/wt");
    db.prepare(
      `INSERT INTO sessions (project_id, number, date, slug, title, filename, created_at)
       VALUES (?, 1, '2026-08-04', 's', 's', 's.md', 0)`
    ).run(id);

    call("wt", { execute: true });

    expect(exited).toBe(1);
    expect(out.join("\n")).toContain("pai project merge");
    // The row must still be there — refusing has to mean refusing.
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
  });

  it("exits non-zero for an unknown slug", () => {
    call("ghost", { execute: true });
    expect(exited).toBe(1);
  });

  it("changes nothing without --execute", () => {
    project("t", "/private/tmp");
    call("t", {});
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    expect(out.join("\n")).toContain("Preview");
  });
});

describe("removing", () => {
  it("removes a zero-session row", () => {
    project("t", "/private/tmp");
    call("t", { execute: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });

  it("leaves nothing behind in any of the five tables", () => {
    const id = project("wt", "/p/.claude/worktrees/wt");
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

    call("wt", { execute: true, force: true });

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
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });

  it("--force is required to take the sessions with it", () => {
    // Deleting sessions is the one genuinely lossy thing here, so it must not be
    // reachable from --execute alone.
    const id = project("wt", "/private/tmp/x");
    db.prepare(
      `INSERT INTO sessions (project_id, number, date, slug, title, filename, created_at)
       VALUES (?, 1, '2026-08-04', 's', 's', 's.md', 0)`
    ).run(id);

    call("wt", { execute: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });

    call("wt", { execute: true, force: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
});
