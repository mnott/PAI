import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./worktree.js";
import { slotPath, prepareSlot, releaseSlot, slotServesRepo } from "./slots.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pai-slots-repo-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.invalid"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

const repo = makeRepo();
const logDir = mkdtempSync(join(tmpdir(), "pai-slots-logs-"));

describe("slots", () => {
  it("slotPath ends with /slots/prov-1", () => {
    expect(slotPath(logDir, "prov", 1)).toMatch(/\/slots\/prov-1$/);
  });

  it("first prepareSlot creates the worktree on branch worker/t1", () => {
    const p = prepareSlot(logDir, "prov", 1, repo, "t1");
    expect(existsSync(p.dir)).toBe(true);
    expect(git(p.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("worker/t1");
    expect(p.base).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(p.salvagePatch).toBeNull();
  });

  it("releaseSlot keeps a committed branch and detaches HEAD", () => {
    const dir = slotPath(logDir, "prov", 1);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "a"]);
    const base = git(repo, ["rev-parse", "HEAD"]);
    expect(releaseSlot(dir, "worker/t1", base).commits).toBe(1);
    expect(() => git(repo, ["rev-parse", "--verify", "worker/t1"])).not.toThrow();
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });

  it("second prepareSlot reuses the same dir", () => {
    const p = prepareSlot(logDir, "prov", 1, repo, "t2");
    expect(p.dir).toBe(slotPath(logDir, "prov", 1));
    expect(git(p.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("worker/t2");
  });

  it("dirty slot is salvaged before the next task", () => {
    const dir = slotPath(logDir, "prov", 1);
    writeFileSync(join(dir, "dirty.txt"), "x\n");
    writeFileSync(join(dir, "base.txt"), "changed\n");
    const p = prepareSlot(logDir, "prov", 1, repo, "t3");
    expect(p.salvagePatch).not.toBeNull();
    expect(existsSync(p.salvagePatch!)).toBe(true);
    expect(existsSync(join(dir, "dirty.txt"))).toBe(false);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("worker/t3");
  });

  it("releaseSlot with zero commits deletes the branch", () => {
    const dir = slotPath(logDir, "prov", 1);
    const base = git(repo, ["rev-parse", "HEAD"]);
    expect(releaseSlot(dir, "worker/t3", base).commits).toBe(0);
    expect(() => git(repo, ["rev-parse", "--verify", "worker/t3"])).toThrow();
  });

  it("slotServesRepo: same repo yes, another repo no", () => {
    expect(slotServesRepo(logDir, "prov", 1, repo)).toBe(true);
    expect(slotServesRepo(logDir, "prov", 1, makeRepo())).toBe(false);
  });
});