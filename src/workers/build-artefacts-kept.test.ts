import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { salvageNotes, worktreePath } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("build artefacts survive worktree cleanup", () => {
  it("keeps a built apk in leftovers, drops intermediates", () => {
    const id = "20261127-000000-1";
    const base = mkdtempSync(join(tmpdir(), "artefact-"));
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    writeFileSync(join(repo, "f.txt"), "base\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "base"]);
    const logDir = join(base, "logs");
    mkdirSync(join(logDir, "worktrees"), { recursive: true });
    const dir = worktreePath(logDir, id);
    git(repo, ["worktree", "add", "-q", "-B", `worker/${id}`, dir, "HEAD"]);
    const files = ["build/app/outputs/x.apk", "build/foo/intermediates/y.txt", "build/foo/intermediates/z.md"];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), "data");
    }
    const lines = salvageNotes(repo, dir, id);
    const leftovers = join(logDir, "leftovers", id);
    expect(existsSync(join(leftovers, "build/app/outputs/x.apk"))).toBe(true);
    expect(lines.join("\n")).toContain("build/app/outputs/x.apk");
    expect(existsSync(join(repo, "build"))).toBe(false);
    expect(existsSync(join(leftovers, "build/foo"))).toBe(false);
    expect(lines.join("\n")).not.toContain("intermediates");
  });
});
