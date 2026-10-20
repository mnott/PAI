import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performScan } from "./scan.js";
import { encodedDirRefusedReason } from "./scan-index.js";
import { getRegistryBackend, closeStorage, __resetStorageForTests } from "../../../storage/factory.js";
import type { SQLiteRegistryBackend } from "../../../storage/registry-sqlite.js";

// Fixtures live under the system temp dir, which the real guards refuse by design.
// Only paths containing "scratchwt" are treated as refused here.
vi.mock("../../../registry/registrable.js", async (orig) => {
  const real = await orig<typeof import("../../../registry/registrable.js")>();
  return {
    ...real,
    pruneWorktreeProjects: async () => [],
    unregistrableReason: (p: string) => (p.includes("scratchwt") ? "a worker worktree" : undefined),
  };
});
vi.mock("./scan-index.js", async (orig) => {
  const real = await orig<typeof import("./scan-index.js")>();
  return { ...real, encodedDirRefusedReason: (e: string) => (e.includes("scratchwt") ? "a worker worktree" : undefined) };
});

let base: string;
let home: string;
let indexFile: string;
const saved: Record<string, string | undefined> = {};

const encode = (p: string) => p.replace(/[\/\s.\-]/g, "-");

function mkProject(name: string): { root: string; enc: string } {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  const enc = encode(root);
  mkdirSync(join(home, ".claude", "projects", enc), { recursive: true });
  return { root, enc };
}

const writes = async () => {
  const b = (await getRegistryBackend()) as SQLiteRegistryBackend;
  return b.getRawDb().prepare("SELECT total_changes() c").get() as { c: number };
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pai-scan-base-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "pai-scan-home-")));
  for (const k of ["HOME", "PAI_HOME"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.PAI_HOME = join(home, ".pai");
  mkdirSync(process.env.PAI_HOME, { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  indexFile = join(home, "idx.json");
  __resetStorageForTests();
});

afterEach(async () => {
  await closeStorage();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("performScan incremental", () => {
  it("skips worktree-path dirs before decoding them", async () => {
    mkProject("scratchwt-a");
    mkProject("real-a");
    const r = await performScan({ indexFile });
    expect(r.filtered).toHaveLength(1);
    expect(r.projectsNew).toBe(1);
  });

  it("second scan with nothing changed writes nothing and skips every project", async () => {
    mkProject("p1");
    mkProject("p2");
    const first = await performScan({ indexFile });
    expect(first.projectsNew).toBe(2);
    const before = (await writes()).c;
    const second = await performScan({ indexFile });
    expect((await writes()).c).toBe(before);
    expect(second.projectsNew).toBe(0);
    expect(second.projectsUpdated).toBe(0);
  });

  it("rescans only the project whose dir mtime changed, and registers its new note", async () => {
    const p1 = mkProject("p1");
    mkProject("p2");
    await performScan({ indexFile });

    const notes = join(home, ".claude", "projects", p1.enc, "Notes");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "0001 - 2026-10-20 - First.md"), "x");
    const future = new Date(Date.now() + 5000);
    utimesSync(join(home, ".claude", "projects", p1.enc), future, future);

    const r = await performScan({ indexFile });
    expect(r.sessionsNew).toBe(1);
    expect(r.projectsUpdated).toBe(1);
  });

  it("a missing registry row defeats the skip (re-registers)", async () => {
    mkProject("p1");
    await performScan({ indexFile });
    const b = (await getRegistryBackend()) as SQLiteRegistryBackend;
    b.getRawDb().prepare("DELETE FROM projects").run();
    const r = await performScan({ indexFile });
    expect(r.projectsNew).toBe(1);
  });

  it("full:true ignores the index", async () => {
    mkProject("p1");
    await performScan({ indexFile });
    const r = await performScan({ indexFile, full: true });
    expect(r.projectsUpdated).toBe(1);
  });
});
