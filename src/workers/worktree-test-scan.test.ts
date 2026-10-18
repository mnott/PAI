import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, git, mergeWorker, recordWorktree, scanDiffForTestLoss } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-testscan-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(join(repo, "src"), { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
const three = "it('a', () => {});\nit('b', () => {});\ntest('c', () => {});\n";
writeFileSync(join(repo, "src", "a.test.ts"), three, "utf8");
writeFileSync(join(repo, "src", "b.test.ts"), "it('x', () => {});\n", "utf8");
writeFileSync(join(repo, "src", "base.ts"), "export const a = 1;\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

afterEach(() => {
  delete process.env.PAI_MERGE_ALLOW_TEST_LOSS;
});

function status(id: string, extra: Partial<WorkerStatus>): void {
  saveStatus(logDir, {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1, ...extra,
  });
}

/** Normal worktree worker whose commit runs `edit` in its tree. */
function task(id: string, edit: (wt: string) => void): void {
  const base = git(repo, ["rev-parse", "HEAD"]);
  const wt = join(dir, `wt-${id}`);
  git(repo, ["worktree", "add", "-q", "-b", `worker/${id}`, wt, base]);
  edit(wt);
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `${id} work`]);
  status(id, { branch: `worker/${id}`, worktreeDir: wt, worktreeBase: base, worktreeSnapshot: false });
}

const dropOne = (wt: string) => writeFileSync(join(wt, "src", "a.test.ts"), "it('a', () => {});\ntest('c', () => {});\n", "utf8");

describe("merge test scan", () => {
  it("reverts a normal merge that removes a test case", () => {
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    task("t1", dropOne);
    expect(() => mergeWorker(logDir, "t1")).toThrow(/test scan failed: src\/a\.test\.ts loses 1 test case\(s\).*PAI_MERGE_ALLOW_TEST_LOSS=1/);
    expect(git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
    expect(readFileSync(join(repo, "src", "a.test.ts"), "utf8")).toBe(three);
  });

  it("restores the checkout when a snapshot merge removes a test case", () => {
    writeFileSync(join(repo, "src", "base.ts"), "export const a = 2;\n", "utf8");
    const info = addWorktree(logDir, "t2", repo);
    expect(info.snapshot).toBe(true);
    const st: WorkerStatus = {
      id: "t2", pid: process.pid, label: "l", cwd: repo, term: "", provider: "p", model: "m",
      state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
      turns: 0, tools: 0, last: "", rc: 0, secs: 1,
    };
    saveStatus(logDir, st);
    recordWorktree(logDir, st, info, true);
    dropOne(info.dir);
    git(info.dir, ["add", "-A"]);
    git(info.dir, ["commit", "-q", "-m", "t2 work"]);
    const before = `${git(repo, ["status", "--porcelain"])}\n${git(repo, ["diff"])}`;
    expect(() => mergeWorker(logDir, "t2")).toThrow(/test scan failed: src\/a\.test\.ts loses 1/);
    expect(`${git(repo, ["status", "--porcelain"])}\n${git(repo, ["diff"])}`).toBe(before);
    expect(readFileSync(join(repo, "src", "a.test.ts"), "utf8")).toBe(three);
    git(repo, ["checkout", "--", "."]);
  });

  it("allows moving a test case between files", () => {
    task("t3", (wt) => {
      dropOne(wt);
      writeFileSync(join(wt, "src", "b.test.ts"), "it('x', () => {});\nit('b', () => {});\n", "utf8");
    });
    expect(mergeWorker(logDir, "t3")).toContain("merged");
    expect(existsSync(join(repo, "src", "b.test.ts"))).toBe(true);
  });

  it("fails when a test file is deleted", () => {
    task("t4", (wt) => rmSync(join(wt, "src", "b.test.ts")));
    expect(() => mergeWorker(logDir, "t4")).toThrow(/test scan failed: src\/b\.test\.ts loses 2 test case/);
    expect(existsSync(join(repo, "src", "b.test.ts"))).toBe(true);
  });

  it("PAI_MERGE_ALLOW_TEST_LOSS=1 lets a deliberate removal through", () => {
    task("t5", (wt) => rmSync(join(wt, "src", "b.test.ts")));
    process.env.PAI_MERGE_ALLOW_TEST_LOSS = "1";
    expect(mergeWorker(logDir, "t5")).toContain("merged");
    expect(existsSync(join(repo, "src", "b.test.ts"))).toBe(false);
  });
});

describe("scanDiffForTestLoss", () => {
  it("ignores non-test files and counts it.skip / test.each forms", () => {
    const d = [
      "diff --git a/src/x.ts b/src/x.ts", "-it('x', () => {});",
      "diff --git a/src/y.test.ts b/src/y.test.ts", "-  it.skip('y', () => {});", "-test.each([1])('z', () => {});", "+it('y', () => {});",
    ].join("\n");
    expect(scanDiffForTestLoss(d)).toBe("src/y.test.ts loses 1 test case(s)");
  });
});
