import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdHere, findProjectsByName, slugFromName } from "./here.js";

/**
 * "This is this project" has to work from inside the directory, because that is
 * the moment the user actually knows what the directory is. Directories get
 * renamed and reorganised, and every other repair command asks for a slug and a
 * path that must be looked up first.
 */

let db: Database.Database;
let tmp: string;

const seed = (
  slug: string,
  displayName: string,
  rootPath: string,
  encoded = rootPath.replace(/\//g, "-")
) =>
  db
    .prepare(
      `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', 'active', 1, 1)`
    )
    .run(slug, displayName, rootPath, encoded);

const rowFor = (slug: string) =>
  db.prepare("SELECT root_path, display_name FROM projects WHERE slug = ?").get(slug) as
    | { root_path: string; display_name: string }
    | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pai-here-")));
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      encoded_dir TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("repointing a project that moved", () => {
  it("points an existing project at the current directory", () => {
    const dest = join(tmp, "new-location");
    mkdirSync(dest);
    seed("jobs-beta", "Jobs Beta", join(tmp, "gone-away"));

    cmdHere(db, "Jobs Beta", { cwd: dest });

    expect(rowFor("jobs-beta")?.root_path).toBe(realpathSync(dest));
  });

  it("finds the project by the name a human uses, not the directory name", () => {
    // The directory gained a word; "Jobs Beta" is not a SUBSTRING of
    // "Jobs Search Beta", which is exactly the case plain matching misses.
    const dest = join(tmp, "Jobs Search Beta");
    mkdirSync(dest);
    seed("jobs-search-beta", "Jobs Search Beta", join(tmp, "stale"));

    cmdHere(db, "Jobs Beta", { cwd: dest });

    expect(rowFor("jobs-search-beta")?.root_path).toBe(realpathSync(dest));
  });

  it("is idempotent — running it again writes nothing new", () => {
    const dest = join(tmp, "stable");
    mkdirSync(dest);
    seed("proj", "Proj", realpathSync(dest), "enc-stable");

    cmdHere(db, "Proj", { cwd: dest });

    expect(rowFor("proj")?.root_path).toBe(realpathSync(dest));
    expect(
      db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }
    ).toEqual({ c: 1 });
  });
});

describe("symlinked parents must not create a second identity", () => {
  it("stores the canonical path when reached through a symlink", () => {
    // This is how one directory becomes two registry rows: reached as
    // /link/child it encodes differently from /real/child, so `add` registers a
    // second project and the sessions split across both.
    const real = join(tmp, "real");
    mkdirSync(real);
    const child = join(real, "proj");
    mkdirSync(child);
    const link = join(tmp, "link");
    symlinkSync(real, link);

    seed("proj", "Proj", join(tmp, "elsewhere"));
    cmdHere(db, "Proj", { cwd: join(link, "proj") });

    expect(rowFor("proj")?.root_path).toBe(realpathSync(child));
    expect(rowFor("proj")?.root_path).not.toContain("link");
  });
});

describe("creating a project that does not exist yet", () => {
  it("creates it pointing here, with a slug from the name", () => {
    const dest = join(tmp, "fresh");
    mkdirSync(dest);

    cmdHere(db, "Brand New", { cwd: dest });

    const row = rowFor("brand-new");
    expect(row?.display_name).toBe("Brand New");
    expect(row?.root_path).toBe(realpathSync(dest));
  });

  it("naming an existing SLUG repoints that project rather than making a second", () => {
    // Matching accepts the slug spelling, so this is a repoint, not a create.
    const dest = join(tmp, "second");
    mkdirSync(dest);
    seed("taken", "Something Else", join(tmp, "first"));

    cmdHere(db, "taken", { cwd: dest });

    expect(rowFor("taken")?.root_path).toBe(realpathSync(dest));
    expect(db.prepare("SELECT COUNT(*) c FROM projects").get()).toEqual({ c: 1 });
  });

  it("suffixes the slug when the derived one is taken by an unrelated project", () => {
    // Reachable when punctuation differs enough that the name does NOT match the
    // existing project, yet reduces to the same slug.
    const dest = join(tmp, "punct");
    mkdirSync(dest);
    seed("odd-name", "Whatever", join(tmp, "first"));

    cmdHere(db, "Odd — Name!", { cwd: dest });

    const rows = db
      .prepare("SELECT slug FROM projects ORDER BY id")
      .all() as Array<{ slug: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[1].slug).toMatch(/^odd-name-/);
  });
});

describe("refusing rather than duplicating", () => {
  it("will not steal a directory another project already owns", () => {
    const dest = join(tmp, "owned");
    mkdirSync(dest);
    const encoded = realpathSync(dest).replace(/\//g, "-");
    seed("owner-proj", "Owner Proj", realpathSync(dest), encoded);
    seed("other-proj", "Other Proj", join(tmp, "other"));

    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);

    expect(() => cmdHere(db, "Other Proj", { cwd: dest })).toThrow("exit");
    expect(rowFor("other-proj")?.root_path).toBe(join(tmp, "other")); // unchanged
    exit.mockRestore();
  });

  it("refuses an ambiguous name instead of guessing", () => {
    const dest = join(tmp, "amb");
    mkdirSync(dest);
    seed("alpha-one", "Alpha One", join(tmp, "a1"));
    seed("alpha-two", "Alpha Two", join(tmp, "a2"));

    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);

    expect(() => cmdHere(db, "Alpha", { cwd: dest })).toThrow("exit");
    exit.mockRestore();
  });
});

describe("name matching", () => {
  it("prefers an exact name over a word-subset match", () => {
    seed("beta", "Beta", "/p/beta");
    seed("beta-extra", "Beta Extra", "/p/beta-extra");
    const found = findProjectsByName(db, "Beta");
    expect(found.map((f) => f.slug)).toEqual(["beta"]);
  });

  it("matches a slug spelling too", () => {
    seed("jobs-beta", "Jobs Beta", "/p/jb");
    expect(findProjectsByName(db, "jobs-beta").map((f) => f.slug)).toEqual(["jobs-beta"]);
  });

  it("does not match a sibling sharing only one word", () => {
    seed("jobs-alpha", "Jobs Alpha", "/p/ja");
    seed("jobs-beta", "Jobs Beta", "/p/jb");
    expect(findProjectsByName(db, "jobs beta").map((f) => f.slug)).toEqual(["jobs-beta"]);
  });

  it("derives sane slugs", () => {
    expect(slugFromName("Jobs Beta")).toBe("jobs-beta");
    expect(slugFromName("  Odd — Name!  ")).toBe("odd-name");
    expect(slugFromName("!!!")).toBe("project");
  });
});
