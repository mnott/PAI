import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "../../../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../../../storage/registry-sqlite.js";
import { renameProject } from "./rename.js";
import { findProject } from "./helpers.js";

let dir: string;
let backend: SQLiteRegistryBackend;
let savedHome: string | undefined;

async function addProject(slug: string, display: string) {
  return backend.createProject({ slug, displayName: display, rootPath: join(dir, slug), encodedDir: slug, createdAt: 1, updatedAt: 1 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-rename-"));
  savedHome = process.env.PAI_HOME;
  process.env.PAI_HOME = join(dir, "home");
  mkdirSync(process.env.PAI_HOME, { recursive: true });
  const db = new DatabaseCtor(":memory:");
  initializeSchema(db);
  backend = new SQLiteRegistryBackend(db);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("project rename", () => {
  it("renames the slug, keeps old as alias, moves sessions and state, refuses collisions, is idempotent", async () => {
    const a = await addProject("alpha", "Alpha");
    await addProject("beta", "Beta");
    await backend.addAlias("gamma", a.id);
    await backend.createSession({ projectId: a.id, number: 1, date: "2026-01-01", slug: "s", title: "t", filename: "f.md", createdAt: 1 });
    writeFileSync(join(process.env.PAI_HOME!, "session-routing.json"), JSON.stringify({ project_paths: { alpha: "/x" } }));
    writeFileSync(join(process.env.PAI_HOME!, "session-profiles.yaml"), "alpha:\n  max_parallel: 2\n");
    const briefs = join(dir, "briefs");
    mkdirSync(briefs);
    writeFileSync(join(briefs, "alpha.md"), "brief");
    const calls: string[][] = [];
    const opts = { briefsDir: briefs, displayName: "Gamma Co", ownerRename: (f: string, t: string) => void calls.push([f, t]) };

    // collision with a different project: refused, nothing changed
    const clash = await renameProject(backend, "alpha", "beta", opts);
    expect(clash.status).toBe("refused");
    expect((await backend.getProjectById(a.id))!.slug).toBe("alpha");

    // dry run writes nothing
    await renameProject(backend, "alpha", "gamma", { ...opts, dryRun: true });
    expect((await backend.getProjectById(a.id))!.slug).toBe("alpha");
    expect(existsSync(join(briefs, "alpha.md"))).toBe(true);

    const r = await renameProject(backend, "alpha", "gamma", opts);
    expect(r.status).toBe("renamed");
    const p = (await backend.getProjectById(a.id))!;
    expect(p.slug).toBe("gamma");
    expect(p.display_name).toBe("Gamma Co");
    expect(p.root_path).toBe(join(dir, "alpha"));
    expect((await findProject(backend, "alpha"))!.id).toBe(a.id); // old slug resolves via alias
    expect(await backend.getProjectByAlias("gamma")).toBeNull(); // own alias became the slug
    expect((await backend.listSessionsForProject(a.id)).length).toBe(1);
    expect(JSON.parse(readFileSync(join(process.env.PAI_HOME!, "session-routing.json"), "utf8")).project_paths).toEqual({ gamma: "/x" });
    expect(readFileSync(join(process.env.PAI_HOME!, "session-profiles.yaml"), "utf8")).toContain("gamma:");
    expect(existsSync(join(briefs, "gamma.md"))).toBe(true);
    expect(calls).toEqual([["Alpha", "Gamma Co"]]);

    expect((await renameProject(backend, "alpha", "gamma", opts)).status).toBe("noop");
  });
});
