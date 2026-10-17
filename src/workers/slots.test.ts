import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { git } from "./worktree.js";
import {
  slotPath,
  prepareSlot,
  releaseSlot,
  slotServesRepo,
  ensureSlotWorktree,
  slotRepo,
} from "./slots.js";

describe("slots", () => {
  let testRepo: string;
  let logDir: string;

  beforeAll(() => {
    // Create a throwaway repo for testing
    testRepo = mkdtempSync(join(tmpdir(), "pai-slots-test-"));
    git(testRepo, ["init"]);
    git(testRepo, ["config", "user.email", "test@example.com"]);
    git(testRepo, ["config", "user.name", "Test User"]);
    git(testRepo, ["commit", "--allow-empty", "-m", "initial commit"]);
    // Create a fresh log directory for each test run
    logDir = mkdtempSync(join(tmpdir(), "pai-slots-logs-"));
  });

  it("slotPath ends with /slots/prov-1", () => {
    const path = slotPath(logDir, "prov", 1);
    expect(path).toMatch(/\/slots\/prov-1$/);
  });

  it("prepareSlot first call creates the worktree dir", () => {
    const dir = ensureSlotWorktree(logDir, "prov", 1, testRepo);
    expect(dir).toMatch(/\/slots\/prov-1$/);
    expect(dir).toBeDefined();
    expect(() => git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).not.toThrow();
    const headRef = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(headRef).toBe("HEAD");
  });

  it("prepareSlot creates branch and sets base correctly", () => {
    // Use a different slot number to avoid conflicts
    const prep = prepareSlot(logDir, "prov", 9, testRepo, "t1");
    expect(prep.branch).toBe("worker/t1");
    expect(prep.base).toBe(git(testRepo, ["rev-parse", "HEAD"]));
    expect(prep.salvagePatch).toBeNull();
  });

  it("releaseSlot returns commits count and handles branch correctly", () => {
    // Create a commit in the slot
    const slotDir = ensureSlotWorktree(logDir, "prov", 3, testRepo);
    git(slotDir, ["checkout", "-b", "worker/t1"]);
    git(slotDir, ["commit", "--allow-empty", "-m", "test commit"]);

    const result = releaseSlot(slotDir, "worker/t1", git(testRepo, ["rev-parse", "HEAD"]));
    expect(result.commits).toBe(1);

    // Branch should still exist (since there was a commit)
    expect(() => git(testRepo, ["rev-parse", "--verify", "worker/t1"])).not.toThrow();

    // Check that the slot is detached
    const headRef = git(slotDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(headRef).toBe("HEAD");
  });

  it("second prepareSlot reuses the same dir", () => {
    const prep1 = prepareSlot(logDir, "prov", 5, testRepo, "t1");
    const prep2 = prepareSlot(logDir, "prov", 5, testRepo, "t2");
    expect(prep1.dir).toBe(prep2.dir);
    expect(prep2.branch).toBe("worker/t2");
  });

  it("dirty reuse with salvagePatch", () => {
    const slotDir = ensureSlotWorktree(logDir, "prov", 6, testRepo);
    // Create a file and commit it to make it dirty
    const dirtyFile = join(slotDir, "dirty.txt");
    const baseFile = join(slotDir, "base.txt");
    // Create a file in the slot
    git(slotDir, ["checkout", "-b", "worker/t3"]);
    git(slotDir, ["commit", "--allow-empty", "-m", "initial"]);

    // Add a new file (untracked)
    const dirtyContent = "dirty content";
    const baseContent = "base content";
    // Create the files
    const fs = require("node:fs");
    fs.writeFileSync(dirtyFile, dirtyContent);
    fs.writeFileSync(baseFile, baseContent);

    // Prepare for slot with dirty state
    const prep = prepareSlot(logDir, "prov", 6, testRepo, "t3");
    expect(prep.salvagePatch).toBeDefined();
    expect(() => fs.accessSync(prep.salvagePatch!)).not.toThrow();
    expect(git(slotDir, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean).length).toBe(0);
    expect(prep.branch).toBe("worker/t3");
  });

  it("releaseSlot with zero commits deletes the branch", () => {
    const slotDir = ensureSlotWorktree(logDir, "prov", 5, testRepo);
    git(slotDir, ["checkout", "-b", "worker/zero"]);

    const result = releaseSlot(slotDir, "worker/zero", git(testRepo, ["rev-parse", "HEAD"]));
    expect(result.commits).toBe(0);

    // Branch should be deleted
    expect(() => git(testRepo, ["rev-parse", "--verify", "worker/zero"])).toThrow();
  });

  it("slotServesRepo correctly identifies repo ownership", () => {
    const slotDir = slotPath(logDir, "prov", 8);
    const slotRepoPath = slotRepo(slotDir);
    expect(slotServesRepo(logDir, "prov", 8, testRepo)).toBe(true);

    // Create a second test repo
    const secondRepo = mkdtempSync(join(tmpdir(), "pai-slots-test-2-"));
    git(secondRepo, ["init"]);
    git(secondRepo, ["config", "user.email", "test2@example.com"]);
    git(secondRepo, ["config", "user.name", "Test User 2"]);
    git(secondRepo, ["commit", "--allow-empty", "-m", "initial commit"]);

    expect(slotServesRepo(logDir, "prov", 8, secondRepo)).toBe(false);
  });
});