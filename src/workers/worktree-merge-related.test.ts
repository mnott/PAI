import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeWorker, RelatedTestsFailedError } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-mergerelated-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

// The worker changes a *.test.ts, so the configured command runs on it.
function task(id: string): void {
  const base = git(repo, ["rev-parse", "HEAD"]);
  const wt = join(dir, `wt-${id}`);
  git(repo, ["worktree", "add", "-q", "-b", `worker/${id}`, wt, base]);
  writeFileSync(join(wt, `${id}.test.ts`), `// ${id}\n`, "utf8");
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

const cfg = (verify: string) => ({ generated: [], regenerate: "", union: [], verify, verifyTimeoutSec: 60, alwaysTests: [] });
const tree = () => git(repo, ["rev-parse", "HEAD^{tree}"]);
const failAlways = (id: string) => `echo "FAIL  ${id}.test.ts"; exit 1 #`;

afterEach(() => {
  delete process.env.PAI_MERGE_KEEP_ON_FAIL;
});

describe("merge related tests", () => {
  it("a test that fails alone too reverts the merge and keeps the branch", () => {
    const before = tree();
    task("r1");
    expect(() => mergeWorker(logDir, "r1", { merge: cfg(failAlways("r1")), rebuild: false })).toThrow(
      /related tests failed: r1\.test\.ts: reverted [0-9a-f]+; branch kept: fix it and merge again/
    );
    expect(git(repo, ["log", "-1", "--format=%s"])).toMatch(/^Revert/);
    expect(tree()).toBe(before);
    expect(existsSync(join(repo, "r1.test.ts"))).toBe(false);
    expect(git(repo, ["rev-parse", "--verify", "worker/r1"])).toBeTruthy();
    expect(existsSync(join(dir, "wt-r1"))).toBe(true);
  });

  it("a flaky-under-load failure keeps the merge", () => {
    task("r2");
    const marker = join(dir, "r2.marker");
    // fails on the first run, passes on the serial re-run
    const verify = `if [ -f ${marker} ]; then exit 0; else touch ${marker}; echo "FAIL  r2.test.ts"; exit 1; fi #`;
    const msg = mergeWorker(logDir, "r2", { merge: cfg(verify), rebuild: false });
    expect(msg).toContain("flaky under load");
    expect(existsSync(join(repo, "r2.test.ts"))).toBe(true);
  });

  it("PAI_MERGE_KEEP_ON_FAIL=1 keeps the merge as before", () => {
    process.env.PAI_MERGE_KEEP_ON_FAIL = "1";
    task("r3");
    expect(() => mergeWorker(logDir, "r3", { merge: cfg(failAlways("r3")), rebuild: false })).toThrow(RelatedTestsFailedError);
    expect(existsSync(join(repo, "r3.test.ts"))).toBe(true);
  });
});
