import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { initializeSchema } from "./schema.js";
import { planMerge, applyMerge, MergeError } from "./merge.js";

/**
 * Folding a duplicate project into the real one.
 *
 * The sessions on the losing row are the only thing of value in it, and
 * `PRAGMA foreign_keys` is 0 on this database — so a plain DELETE does not fail,
 * it silently orphans rows across sessions, project_tags, aliases,
 * compaction_log and links. Five tables, no complaint from SQLite.
 *
 * The renumbering is the part nobody predicts: sessions are UNIQUE on
 * (project_id, number), so incoming sessions cannot keep their own numbers.
 */

let dir: string;
let db: Database;

function project(slug: string, path: string, status = "active"): number {
  const info = db
    .prepare(
      `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', ?, 0, 0)`
    )
    .run(slug, slug, path, path.replace(/\//g, "-"), status);
  return Number(info.lastInsertRowid);
}

function session(projectId: number, number: number, slug = "s"): number {
  const info = db
    .prepare(
      `INSERT INTO sessions (project_id, number, date, slug, title, filename, created_at)
       VALUES (?, ?, '2026-08-04', ?, ?, ?, 0)`
    )
    .run(projectId, number, slug, slug, `${slug}.md`);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-merge-"));
  db = new DatabaseCtor(join(dir, "r.db"));
  initializeSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("planning", () => {
  it("renumbers incoming sessions to continue the target's numbering", () => {
    const into = project("infrastruktur", "/a");
    const from = project("stadtoldendorf", "/b");
    session(into, 1);
    session(into, 2);
    session(into, 3);
    const moved = session(from, 1);

    const plan = planMerge(db, "stadtoldendorf", "infrastruktur");
    expect(plan.sessions).toEqual([{ id: moved, from: 1, to: 4 }]);
  });

  it("numbers several incoming sessions in their original order", () => {
    const into = project("into", "/a");
    const from = project("from", "/b");
    session(into, 1);
    session(from, 7);
    session(from, 2);

    const plan = planMerge(db, "from", "into");
    expect(plan.sessions.map((s) => [s.from, s.to])).toEqual([
      [2, 2],
      [7, 3],
    ]);
  });

  it("starts at 1 when the target has no sessions", () => {
    project("into", "/a");
    const from = project("from", "/b");
    session(from, 9);
    expect(planMerge(db, "from", "into").sessions[0]!.to).toBe(1);
  });

  it("refuses an unknown slug on either side", () => {
    project("real", "/a");
    expect(() => planMerge(db, "ghost", "real")).toThrow(MergeError);
    expect(() => planMerge(db, "real", "ghost")).toThrow(MergeError);
  });

  it("refuses to merge a project into itself", () => {
    project("real", "/a");
    expect(() => planMerge(db, "real", "real")).toThrow(MergeError);
  });
});

describe("applying", () => {
  it("moves the sessions and removes the losing row", () => {
    const into = project("into", "/a");
    const from = project("from", "/b");
    session(into, 1);
    session(from, 1, "moved-one");

    applyMerge(db, planMerge(db, "from", "into"));

    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    const rows = db
      .prepare("SELECT number, slug FROM sessions WHERE project_id = ? ORDER BY number")
      .all(into) as { number: number; slug: string }[];
    expect(rows).toEqual([
      { number: 1, slug: "s" },
      { number: 2, slug: "moved-one" },
    ]);
  });

  it("keeps the old slug resolvable as an alias", () => {
    // Someone will type the old name, and PAI itself may have written it into a
    // note. Losing the name silently is a worse outcome than a stale alias.
    const into = project("infrastruktur", "/a");
    project("stadtoldendorf", "/b");

    applyMerge(db, planMerge(db, "stadtoldendorf", "infrastruktur"));

    expect(
      db.prepare("SELECT project_id FROM aliases WHERE alias = ?").get("stadtoldendorf")
    ).toEqual({ project_id: into });
  });

  it("carries the loser's existing aliases across", () => {
    const into = project("into", "/a");
    const from = project("from", "/b");
    db.prepare("INSERT INTO aliases (alias, project_id) VALUES (?, ?)").run("old", from);

    applyMerge(db, planMerge(db, "from", "into"));

    expect(db.prepare("SELECT project_id FROM aliases WHERE alias = ?").get("old")).toEqual({
      project_id: into,
    });
  });

  it("does not orphan tags, and tolerates a tag both projects share", () => {
    // project_tags is PRIMARY KEY (project_id, tag_id), so a shared tag would
    // collide on a naive UPDATE.
    const into = project("into", "/a");
    const from = project("from", "/b");
    const tag = Number(
      db.prepare("INSERT INTO tags (name) VALUES (?)").run("infra").lastInsertRowid
    );
    db.prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)").run(into, tag);
    db.prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)").run(from, tag);

    applyMerge(db, planMerge(db, "from", "into"));

    expect(db.prepare("SELECT COUNT(*) AS n FROM project_tags").get()).toEqual({ n: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?").get(from)
    ).toEqual({ n: 0 });
  });

  it("does not orphan compaction_log rows", () => {
    const into = project("into", "/a");
    const from = project("from", "/b");
    db.prepare(
      `INSERT INTO compaction_log (project_id, trigger, files_written, created_at)
       VALUES (?, 'manual', 'x', 0)`
    ).run(from);

    applyMerge(db, planMerge(db, "from", "into"));

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM compaction_log WHERE project_id = ?").get(into)
    ).toEqual({ n: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM compaction_log WHERE project_id = ?").get(from)
    ).toEqual({ n: 0 });
  });

  it("repoints links, and drops a link that would point a project at itself", () => {
    // A session in the TARGET that linked to the loser would, after the merge,
    // link to its own project. links is UNIQUE (session_id, target_project_id).
    const into = project("into", "/a");
    const from = project("from", "/b");
    const s = session(into, 1);
    db.prepare(
      "INSERT INTO links (session_id, target_project_id, created_at) VALUES (?, ?, 0)"
    ).run(s, from);

    applyMerge(db, planMerge(db, "from", "into"));

    expect(db.prepare("SELECT COUNT(*) AS n FROM links").get()).toEqual({ n: 0 });
  });

  it("leaves nothing behind in any of the five tables", () => {
    // The point of one function rather than five hand-written updates: with
    // foreign keys off, SQLite will not tell you which one you forgot.
    const into = project("into", "/a");
    const from = project("from", "/b");
    const s = session(from, 1);
    const tag = Number(
      db.prepare("INSERT INTO tags (name) VALUES (?)").run("t").lastInsertRowid
    );
    db.prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)").run(from, tag);
    db.prepare("INSERT INTO aliases (alias, project_id) VALUES (?, ?)").run("a", from);
    db.prepare(
      `INSERT INTO compaction_log (project_id, session_id, trigger, files_written, created_at)
       VALUES (?, ?, 'manual', 'x', 0)`
    ).run(from, s);
    db.prepare(
      "INSERT INTO links (session_id, target_project_id, created_at) VALUES (?, ?, 0)"
    ).run(s, from);

    applyMerge(db, planMerge(db, "from", "into"));

    for (const [table, column] of [
      ["sessions", "project_id"],
      ["project_tags", "project_id"],
      ["aliases", "project_id"],
      ["compaction_log", "project_id"],
      ["links", "target_project_id"],
    ] as const) {
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(from),
        table
      ).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(from)).toEqual({
      n: 0,
    });
  });
});
