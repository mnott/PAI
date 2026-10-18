import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeWorker } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-stubscan-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(join(repo, "src"), { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "src", "base.ts"), "export const a = 1;\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

function task(id: string, file: string, body: string): void {
  const base = git(repo, ["rev-parse", "HEAD"]);
  const wt = join(dir, `wt-${id}`);
  git(repo, ["worktree", "add", "-q", "-b", `worker/${id}`, wt, base]);
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, file), body, "utf8");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `${id} work`]);
  const s: WorkerStatus = {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
    branch: `worker/${id}`, worktreeDir: wt, worktreeBase: base, worktreeSnapshot: false,
  };
  saveStatus(logDir, s);
}

describe("merge stub scan", () => {
  it("reverts a merge that adds a stub under src/, without --verify", () => {
    const before = git(repo, ["rev-parse", "HEAD^{tree}"]);
    task("s1", "src/s1.ts", "export const x = 1;\nexport function f() {\n  throw new Error('not implemented');\n}\n");
    expect(() => mergeWorker(logDir, "s1")).toThrow(/stub scan failed: src\/s1\.ts:3: reverted [0-9a-f]+/);
    expect(git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(before);
    expect(existsSync(join(repo, "src", "s1.ts"))).toBe(false);
    expect(git(repo, ["rev-parse", "--verify", "worker/s1"])).toBeTruthy();
  });

  it("reverts after a passing verify too", () => {
    task("s2", "src/s2.ts", "// TODO: implement later\n");
    expect(() => mergeWorker(logDir, "s2", { verify: "true" })).toThrow(/stub scan failed: src\/s2\.ts:1/);
  });

  it("ignores stub text outside src/", () => {
    task("s3", "docs.md", "TODO: implement the thing\n");
    expect(mergeWorker(logDir, "s3")).toContain("branch deleted");
  });

  it("passes a clean src change", () => {
    task("s4", "src/s4.ts", "export const y = 2;\n");
    expect(mergeWorker(logDir, "s4")).toContain("branch deleted");
  });
});
