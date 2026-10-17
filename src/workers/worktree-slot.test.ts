import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { git } from "./worktree.js";
import { saveStatus } from "./status.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

function status(id: string, branch: string, worktreeDir: string, cwd: string): any {
  return {
    id,
    label: `test worker ${id}`,
    state: "done",
    cwd,
    branch,
    worktreeDir,
    worktreeBase: "abcdef1234567890",
    worktreeSnapshot: false,
    merged: false,
    resumedBy: null,
    archived: null,
    commits: 1,
  };
}

// Create a throwaway repo for testing
const repo = mkdtempSync(join(tmpdir(), "pai-test-"));
mkdirSync(repo, { recursive: true });
git(repo, ["init"]);
git(repo, ["config", "user.email", "test@example.com"]);
git(repo, ["config", "user.name", "Test User"]);
git(repo, ["commit", "--allow-empty", "-m", "initial commit"]);

const logDir = join(repo, "logs");
mkdirSync(logDir, { recursive: true });

// Create a slot worktree manually
const slotsDir = join(logDir, "slots");
mkdirSync(slotsDir, { recursive: true });
const slotDir = join(slotsDir, "prov-1");
git(repo, ["worktree", "add", "--detach", slotDir, "HEAD"]);

// Create a task on the slot worktree
git(slotDir, ["checkout", "-q", "-b", "worker/s1"]);
// Create a file to be committed
const aFile = join(slotDir, "a.txt");
import { writeFileSync } from "node:fs";
writeFileSync(aFile, "test content");
git(slotDir, ["add", "a.txt"]);
git(slotDir, ["commit", "-m", "add a.txt"]);
// Detach from the branch to simulate a completed task
git(slotDir, ["checkout", "-q", "--detach"]);

// Save a status for the task
saveStatus(logDir, status("s1", "worker/s1", slotDir, repo));

// Test cases
console.log("Testing isSlotWorktree function...");
import { isSlotWorktree } from "./worktree.js";
console.log("isSlotWorktree(slotDir):", isSlotWorktree(slotDir));
console.log("isSlotWorktree(worktreePath(logDir, 'x')):", isSlotWorktree(join(logDir, "worktrees", "x")));

console.log("\nTesting mergeWorker function...");
import { mergeWorker } from "./worktree.js";
const result = mergeWorker(logDir, "s1");
console.log("mergeWorker result:", result);
console.log("slotDir still exists:", existsSync(slotDir));
console.log("a.txt still exists in repo:", existsSync(join(repo, "a.txt")));
try {
  git(repo, ["rev-parse", "--verify", "worker/s1"]);
  console.log("branch worker/s1 still exists: false");
} catch {
  console.log("branch worker/s1 gone: true");
}

console.log("\nTesting discardWorker function...");
// Create a second task on the same slot
git(slotDir, ["checkout", "-q", "-b", "worker/s2"]);
const bFile = join(slotDir, "b.txt");
writeFileSync(bFile, "test content 2");
git(slotDir, ["add", "b.txt"]);
git(slotDir, ["commit", "-m", "add b.txt"]);
git(slotDir, ["checkout", "-q", "--detach"]);
saveStatus(logDir, status("s2", "worker/s2", slotDir, repo));

import { discardWorker } from "./worktree.js";
const discardResult = discardWorker(logDir, "s2");
console.log("discardWorker result:", discardResult);
console.log("slotDir still exists after discard:", existsSync(slotDir));
try {
  git(repo, ["rev-parse", "--verify", "worker/s2"]);
  console.log("branch worker/s2 still exists: false");
} catch {
  console.log("branch worker/s2 gone: true");
}

console.log("\nTesting gcWorktrees function...");
import { gcWorktrees } from "./worktree.js";
const gcResult = gcWorktrees(logDir, 0);
console.log("gcWorktrees result:", gcResult);
console.log("slotDir still exists after gc:", existsSync(slotDir));