/**
 * Salvage keeps gitignored knowledge text, skips caches and binaries.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, salvageIgnored } from "./worktree.js";

vi.setConfig({ testTimeout: 30_000 });

function repoWith(ignore: string) {
  const dir = mkdtempSync(join(tmpdir(), "pai-salv-bin-"));
  const repo = join(dir, "repo");
  const wt = join(dir, "wt");
  for (const d of [repo, wt]) {
    mkdirSync(d, { recursive: true });
    git(d, ["init", "-q", "-b", "main"]);
    writeFileSync(join(d, ".gitignore"), ignore);
  }
  return { repo, wt };
}

describe("salvageIgnored", () => {
  it("keeps Notes/x.md, skips __pycache__/x.pyc and a binary blob, reports the count", () => {
    const { repo, wt } = repoWith("Notes/\n__pycache__/\n*.bin\nblob*\n");
    mkdirSync(join(wt, "Notes"));
    writeFileSync(join(wt, "Notes", "x.md"), "knowledge\n");
    mkdirSync(join(wt, "tools", "__pycache__"), { recursive: true });
    writeFileSync(join(wt, "tools", "__pycache__", "x.pyc"), Buffer.from([0x0d, 0xf3, 0x0d, 0x0a, 0, 1, 2]));
    writeFileSync(join(wt, "blob.bin"), Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81]));
    writeFileSync(join(wt, "blob-nonul"), Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81]));
    // same name already in the checkout with different content: still no .md rename for a blob
    mkdirSync(join(repo, "tools", "__pycache__"), { recursive: true });
    writeFileSync(join(repo, "tools", "__pycache__", "x.pyc"), "other");

    const r = salvageIgnored(repo, wt, "w1");
    expect(existsSync(join(repo, "Notes", "x.md"))).toBe(true);
    expect(readdirSync(join(repo, "tools", "__pycache__"))).toEqual(["x.pyc"]);
    expect(existsSync(join(repo, "blob.bin"))).toBe(false);
    expect(existsSync(join(repo, "blob-nonul"))).toBe(false);
    expect(r.lines).toContain("skipped 3 cache/binary files");
    expect(r.lines.filter((l) => l.startsWith("salvaged"))).toHaveLength(1);
  });
});
