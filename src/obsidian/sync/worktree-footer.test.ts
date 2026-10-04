import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "../../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../../storage/registry-sqlite.js";
import { ensurePaiMarker } from "../../registry/pai-marker.js";
import { generateMasterNotes } from "./master.js";
import { syncVault } from "./symlinks.js";

const WORKER_ID = "20261004-143957-72299";
const PAI_MD = '---\npai:\n  slug: "demo"\n---\n';

let dir: string;
let main: string;
let worktree: string;
let vault: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-wt-footer-"));
  main = join(dir, "demo");
  worktree = join(dir, "worktrees", WORKER_ID);
  vault = join(dir, "vault");
  mkdirSync(join(main, ".git"), { recursive: true });
  mkdirSync(join(main, "Notes"));
  writeFileSync(join(main, "Notes", "PAI.md"), PAI_MD);
  mkdirSync(join(worktree, "Notes"), { recursive: true });
  writeFileSync(join(worktree, "Notes", "PAI.md"), PAI_MD);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", WORKER_ID)}\n`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function backendWithWorktreeRow() {
  const db = new DatabaseCtor(":memory:");
  initializeSchema(db);
  const backend = new SQLiteRegistryBackend(db);
  const ts = Date.now();
  await backend.createProject({
    slug: WORKER_ID, displayName: WORKER_ID, rootPath: worktree, encodedDir: "enc-wt",
    type: "local", status: "active", createdAt: ts, updatedAt: ts,
  });
  return { db, backend };
}

describe("worktree-rooted registry row never rewrites shared notes", () => {
  it("generateMasterNotes leaves session note footers unchanged", async () => {
    const { db, backend } = await backendWithWorktreeRow();
    const slugDir = join(vault, WORKER_ID);
    mkdirSync(slugDir, { recursive: true });
    symlinkSync(join(worktree, "Notes"), join(slugDir, "notes"));
    const original = "# Session\n\nbody\n\n---\n[[_demo-master|← Demo Master]]\n";
    const notes = [1, 2, 3, 4, 5].map((i) => join(worktree, "Notes", `000${i} - 2026-10-0${i} - n.md`));
    for (const n of notes) writeFileSync(n, original);
    expect(await generateMasterNotes(vault, backend, 5)).toBe(0);
    for (const n of notes) expect(readFileSync(n, "utf8")).toBe(original);
    expect(existsSync(join(slugDir, `_${WORKER_ID}-master.md`))).toBe(false);
    db.close();
  });

  it("syncVault creates no vault dir for the worktree row", async () => {
    const { db, backend } = await backendWithWorktreeRow();
    await syncVault(vault, backend);
    expect(existsSync(join(vault, WORKER_ID))).toBe(false);
    db.close();
  });

  it("ensurePaiMarker with cwd = worktree keeps slug demo", () => {
    ensurePaiMarker(worktree, WORKER_ID);
    expect(readFileSync(join(worktree, "Notes", "PAI.md"), "utf8")).toBe(PAI_MD);
  });
});
