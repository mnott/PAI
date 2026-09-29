/**
 * Regression: an exit salvage must never commit the deletion of tracked files
 * the worker did not delete. Throwaway repo in a tmp dir only.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, git, salvageUncommitted } from "./worktree.js";

const OLD_IGNORE = ".claude/*\n!.claude/skills/\n!.claude/commands/\nNotes/*\n!Notes/docs/\n";
const NEW_IGNORE = ".claude/*\n!.claude/skills/\n!.claude/commands/\nNotes/\nnotes/\nTODO*.md\n.aibroker/\n";

function put(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
}

function setup(): { repo: string; logDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pai-salvage-del-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  put(repo, ".gitignore", OLD_IGNORE);
  put(repo, ".claude/commands/advisor.md", "a\n");
  put(repo, ".claude/skills/setup/SKILL.md", "s\n");
  put(repo, "Notes/TODO.md", "t\n");
  put(repo, "Notes/docs/faq.md", "f\n");
  put(repo, ".aibroker/session.md", "x\n");
  put(repo, "base.txt", "base\n");
  git(repo, ["add", "-f", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, logDir: join(dir, "logdir") };
}

describe("salvage never commits deletions the worker did not make", () => {
  it("dirty checkout untracking ignored dirs: salvage carries only the change", () => {
    const { repo, logDir } = setup();
    // operator mid-untrack: new .gitignore, files removed from the index only
    put(repo, ".gitignore", NEW_IGNORE);
    git(repo, ["rm", "-r", "-q", "--cached", "Notes", ".aibroker"]);
    const info = addWorktree(logDir, "w1", repo);
    // the worker sees every file the base tracks
    const tracked = git(info.dir, ["ls-files"]).split("\n");
    for (const p of tracked) expect(existsSync(join(info.dir, p)), p).toBe(true);

    put(info.dir, "base.txt", "changed\n");
    salvageUncommitted(info.dir, "one line");
    const deleted = git(info.dir, ["diff", "--diff-filter=D", "--name-only", `${info.base}..HEAD`]);
    expect(deleted).toBe("");
    expect(git(info.dir, ["diff", "--name-only", `${info.base}..HEAD`])).toBe("base.txt");
  });

  it("files missing from the worktree are reported, not committed as deleted", () => {
    const { repo, logDir } = setup();
    const info = addWorktree(logDir, "w2", repo);
    const gone = [".claude/commands/advisor.md", "Notes/TODO.md", "Notes/docs/faq.md"];
    for (const p of gone) rmSync(join(info.dir, p), { force: true });
    put(info.dir, "base.txt", "changed\n");
    const r = salvageUncommitted(info.dir, "one line");
    expect(r.committed).toEqual(["base.txt"]);
    expect(r.skipped.join("\n")).toContain("missing, not committed");
    expect(git(info.dir, ["diff", "--diff-filter=D", "--name-only", `${info.base}..HEAD`])).toBe("");
    expect(git(info.dir, ["diff", "--name-only", `${info.base}..HEAD`])).toBe("base.txt");
  });

  it("refuses a salvage whose staged deletions exceed the limit", () => {
    const { repo, logDir } = setup();
    for (let i = 0; i < 6; i++) put(repo, `many/f${i}.txt`, "x\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "more"]);
    const info = addWorktree(logDir, "w3", repo);
    git(info.dir, ["rm", "-rq", "many"]);
    put(info.dir, "base.txt", "changed\n");
    expect(() => salvageUncommitted(info.dir, "bulk")).toThrow(/refused/);
    expect(git(info.dir, ["rev-list", "--count", `${info.base}..HEAD`])).toBe("0");
  });
});
