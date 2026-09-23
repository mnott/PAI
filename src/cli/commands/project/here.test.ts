import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdHere, findProjectsByName, slugFromName } from "./here.js";
import { getRegistryBackend, closeStorage, __resetStorageForTests } from "../../../storage/factory.js";
import type { SQLiteRegistryBackend } from "../../../storage/registry-sqlite.js";

/**
 * "This is this project" has to work from inside the directory, because that is
 * the moment the user actually knows what the directory is. Directories get
 * renamed and reorganised, and every other repair command asks for a slug and a
 * path that must be looked up first.
 */

let tmp: string;
let paiHome: string;
let originalPaiHome: string | undefined;

const seed = (
  slug: string,
  displayName: string,
  rootPath: string,
  encoded = rootPath.replace(/\//g, "-")
) =>
  getRegistryBackend().then((backend) =>
    (backend as SQLiteRegistryBackend)
      .getRawDb()
      .prepare(
        `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'local', 'active', 1, 1)`
      )
      .run(slug, displayName, rootPath, encoded)
  );

const rowFor = async (slug: string) => {
  const backend = (await getRegistryBackend()) as SQLiteRegistryBackend;
  return backend.getRawDb().prepare("SELECT root_path, display_name FROM projects WHERE slug = ?").get(slug) as
    | { root_path: string; display_name: string }
    | undefined;
};

const countProjects = async () => {
  const backend = (await getRegistryBackend()) as SQLiteRegistryBackend;
  return backend.getRawDb().prepare("SELECT COUNT(*) c FROM projects").get() as { c: number };
};

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pai-here-")));
  paiHome = mkdtempSync(join(tmpdir(), "pai-here-home-"));
  originalPaiHome = process.env.PAI_HOME;
  process.env.PAI_HOME = paiHome;
  __resetStorageForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await closeStorage();
  if (originalPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = originalPaiHome;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(paiHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("repointing a project that moved", () => {
  it("points an existing project at the current directory", async () => {
    const dest = join(tmp, "new-location");
    mkdirSync(dest);
    await seed("jobs-beta", "Jobs Beta", join(tmp, "gone-away"));

    await cmdHere("Jobs Beta", { cwd: dest });

    expect((await rowFor("jobs-beta"))?.root_path).toBe(realpathSync(dest));
  });

  it("finds the project by the name a human uses, not the directory name", async () => {
    // The directory gained a word; "Jobs Beta" is not a SUBSTRING of
    // "Jobs Search Beta", which is exactly the case plain matching misses.
    const dest = join(tmp, "Jobs Search Beta");
    mkdirSync(dest);
    await seed("jobs-search-beta", "Jobs Search Beta", join(tmp, "stale"));

    await cmdHere("Jobs Beta", { cwd: dest });

    expect((await rowFor("jobs-search-beta"))?.root_path).toBe(realpathSync(dest));
  });

  it("is idempotent — running it again writes nothing new", async () => {
    const dest = join(tmp, "stable");
    mkdirSync(dest);
    await seed("proj", "Proj", realpathSync(dest), "enc-stable");

    await cmdHere("Proj", { cwd: dest });

    expect((await rowFor("proj"))?.root_path).toBe(realpathSync(dest));
    expect(await countProjects()).toEqual({ c: 1 });
  });
});

describe("symlinked parents must not create a second identity", () => {
  it("stores the canonical path when reached through a symlink", async () => {
    // This is how one directory becomes two registry rows: reached as
    // /link/child it encodes differently from /real/child, so `add` registers a
    // second project and the sessions split across both.
    const real = join(tmp, "real");
    mkdirSync(real);
    const child = join(real, "proj");
    mkdirSync(child);
    const link = join(tmp, "link");
    symlinkSync(real, link);

    await seed("proj", "Proj", join(tmp, "elsewhere"));
    await cmdHere("Proj", { cwd: join(link, "proj") });

    expect((await rowFor("proj"))?.root_path).toBe(realpathSync(child));
    expect((await rowFor("proj"))?.root_path).not.toContain("link");
  });
});

describe("creating a project that does not exist yet", () => {
  it("creates it pointing here, with a slug from the name", async () => {
    const dest = join(tmp, "fresh");
    mkdirSync(dest);

    await cmdHere("Brand New", { cwd: dest });

    const row = await rowFor("brand-new");
    expect(row?.display_name).toBe("Brand New");
    expect(row?.root_path).toBe(realpathSync(dest));
  });

  it("naming an existing SLUG repoints that project rather than making a second", async () => {
    // Matching accepts the slug spelling, so this is a repoint, not a create.
    const dest = join(tmp, "second");
    mkdirSync(dest);
    await seed("taken", "Something Else", join(tmp, "first"));

    await cmdHere("taken", { cwd: dest });

    expect((await rowFor("taken"))?.root_path).toBe(realpathSync(dest));
    expect(await countProjects()).toEqual({ c: 1 });
  });

  it("suffixes the slug when the derived one is taken by an unrelated project", async () => {
    // Reachable when punctuation differs enough that the name does NOT match the
    // existing project, yet reduces to the same slug.
    const dest = join(tmp, "punct");
    mkdirSync(dest);
    await seed("odd-name", "Whatever", join(tmp, "first"));

    await cmdHere("Odd — Name!", { cwd: dest });

    const backend = (await getRegistryBackend()) as SQLiteRegistryBackend;
    const rows = backend.getRawDb().prepare("SELECT slug FROM projects ORDER BY id").all() as Array<{
      slug: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[1].slug).toMatch(/^odd-name-/);
  });
});

describe("refusing rather than duplicating", () => {
  it("will not steal a directory another project already owns", async () => {
    const dest = join(tmp, "owned");
    mkdirSync(dest);
    const encoded = realpathSync(dest).replace(/\//g, "-");
    await seed("owner-proj", "Owner Proj", realpathSync(dest), encoded);
    await seed("other-proj", "Other Proj", join(tmp, "other"));

    // cmdHere sets process.exitCode and returns normally on refusal — it no
    // longer calls process.exit() (see src/cli/lib/exit.ts for why: exit()
    // can truncate output still in flight to a pipe).
    process.exitCode = undefined;
    await cmdHere("Other Proj", { cwd: dest });
    expect(process.exitCode).toBe(1);
    expect((await rowFor("other-proj"))?.root_path).toBe(join(tmp, "other")); // unchanged
    process.exitCode = undefined;
  });

  it("refuses an ambiguous name instead of guessing", async () => {
    const dest = join(tmp, "amb");
    mkdirSync(dest);
    await seed("alpha-one", "Alpha One", join(tmp, "a1"));
    await seed("alpha-two", "Alpha Two", join(tmp, "a2"));

    process.exitCode = undefined;
    await cmdHere("Alpha", { cwd: dest });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

describe("name matching", () => {
  it("prefers an exact name over a word-subset match", async () => {
    await seed("beta", "Beta", "/p/beta");
    await seed("beta-extra", "Beta Extra", "/p/beta-extra");
    const found = await findProjectsByName("Beta");
    expect(found.map((f) => f.slug)).toEqual(["beta"]);
  });

  it("matches a slug spelling too", async () => {
    await seed("jobs-beta", "Jobs Beta", "/p/jb");
    expect((await findProjectsByName("jobs-beta")).map((f) => f.slug)).toEqual(["jobs-beta"]);
  });

  it("does not match a sibling sharing only one word", async () => {
    await seed("jobs-alpha", "Jobs Alpha", "/p/ja");
    await seed("jobs-beta", "Jobs Beta", "/p/jb");
    expect((await findProjectsByName("jobs beta")).map((f) => f.slug)).toEqual(["jobs-beta"]);
  });

  it("derives sane slugs", () => {
    expect(slugFromName("Jobs Beta")).toBe("jobs-beta");
    expect(slugFromName("  Odd — Name!  ")).toBe("odd-name");
    expect(slugFromName("!!!")).toBe("project");
  });
});
