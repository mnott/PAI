import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../storage/registry-sqlite.js";
import { upsertProject } from "../cli/commands/registry/utils.js";
import { ensurePaiMarker } from "./pai-marker.js";
import { isLinkedWorktree, mainRepoOf, worktreeReason, pruneWorktreeProjects } from "./registrable.js";

let dir: string;
let worktree: string;
let normal: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-wt-guard-"));
  worktree = join(dir, "wt");
  normal = join(dir, "repo");
  mkdirSync(worktree);
  mkdirSync(join(normal, ".git"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(normal, ".git", "worktrees", "wt")}\n`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("linked worktree guard", () => {
  it("is true for a .git file with gitdir:, false for a .git dir", () => {
    expect(isLinkedWorktree(worktree)).toBe(true);
    expect(isLinkedWorktree(normal)).toBe(false);
    expect(mainRepoOf(worktree)).toBe(normal);
  });

  it("unregistrableReason names the worktree and its main repo", () => {
    expect(worktreeReason(worktree, undefined)).toContain(normal);
  });

  it("refuses a path under the worker worktrees root", () => {
    expect(worktreeReason(join(dir, "wts", "abc"), join(dir, "wts"))).toContain("worker worktree");
  });

  it("upsertProject is a no-op for a worktree", async () => {
    const db = new DatabaseCtor(":memory:");
    initializeSchema(db);
    const backend = new SQLiteRegistryBackend(db);
    expect(await upsertProject(backend, "wt", worktree, "enc-wt")).toBeNull();
    expect(await backend.listProjects({})).toHaveLength(0);
    db.close();
  });

  it("ensurePaiMarker leaves a worktree's PAI.md untouched", () => {
    mkdirSync(join(worktree, "Notes"));
    const marker = join(worktree, "Notes", "PAI.md");
    const original = '---\npai:\n  slug: "real"\n---\n';
    writeFileSync(marker, original);
    ensurePaiMarker(worktree, "worker-id");
    expect(readFileSync(marker, "utf8")).toBe(original);
  });
});

describe("pruneWorktreeProjects", () => {
  it("removes worktree and worker-root rows, keeps real projects", async () => {
    const db = new DatabaseCtor(":memory:");
    initializeSchema(db);
    const backend = new SQLiteRegistryBackend(db);
    const ts = Date.now();
    const add = (slug: string, rootPath: string) =>
      backend.createProject({
        slug, displayName: slug, rootPath, encodedDir: `enc-${slug}`,
        type: "local", status: "active", createdAt: ts, updatedAt: ts,
      });
    await add("linked", worktree);
    await add("gone", join(dir, "wts", "gone-worker"));
    await add("real", normal);

    const removed = await pruneWorktreeProjects(backend, join(dir, "wts"));
    expect(removed.sort()).toEqual(["gone", "linked"]);
    expect((await backend.listProjects({})).map((p) => p.slug)).toEqual(["real"]);
    db.close();
  });
});
