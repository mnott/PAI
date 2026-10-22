import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeWorker } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-mergebytes-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "latin.txt"), Buffer.from("caf\xe9 one\n", "latin1"));
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

describe("merge of non-UTF-8 text", () => {
  it("applies a Latin-1 edit byte-exact", () => {
    const base = git(repo, ["rev-parse", "HEAD"]);
    const wt = join(dir, "wt-b1");
    git(repo, ["worktree", "add", "-q", "-b", "worker/b1", wt, base]);
    const edited = Buffer.from("caf\xe9 two\nna\xefve\n", "latin1");
    writeFileSync(join(wt, "latin.txt"), edited);
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "worker change"]);
    const s: WorkerStatus = {
      id: "b1", pid: process.pid, label: "bytes", cwd: repo, term: "", provider: "p", model: "m",
      state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
      turns: 0, tools: 0, last: "", rc: 0, secs: 1,
      branch: "worker/b1", worktreeDir: wt, worktreeBase: base, worktreeSnapshot: true,
    };
    saveStatus(logDir, s);
    mergeWorker(logDir, "b1");
    expect(readFileSync(join(repo, "latin.txt")).equals(edited)).toBe(true);
  });
});
