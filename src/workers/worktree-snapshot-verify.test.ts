import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, git, mergeWorker, recordWorktree } from "./worktree.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-snapverify-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

/** A snapshot-based worker (dirty checkout) that committed one new file. */
function snapWorker(id: string, content = "work\n"): { dir: string; branch: string } {
  writeFileSync(join(repo, "base.txt"), `dirty ${id}\n`, "utf8");
  const info = addWorktree(logDir, id, repo);
  expect(info.snapshot).toBe(true);
  const st: WorkerStatus = {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
  };
  saveStatus(logDir, st);
  recordWorktree(logDir, st, info, true);
  mkdirSync(join(info.dir, "src"), { recursive: true });
  writeFileSync(join(info.dir, "src", `${id}.ts`), content, "utf8");
  git(info.dir, ["add", "-A"]);
  git(info.dir, ["commit", "-q", "-m", `${id} work`]);
  return info;
}

const state = () => `${git(repo, ["status", "--porcelain"])}\n${git(repo, ["diff"])}\n${readFileSync(join(repo, "base.txt"), "utf8")}`;

describe("snapshot merge --verify", () => {
  it("passing verify applies and reports it", () => {
    const info = snapWorker("sv1");
    const msg = mergeWorker(logDir, "sv1", { verify: "test -f src/sv1.ts" });
    expect(msg).toContain("verify passed: test -f src/sv1.ts");
    expect(msg).toContain("as uncommitted changes");
    expect(existsSync(join(repo, "src", "sv1.ts"))).toBe(true);
    expect(existsSync(info.dir)).toBe(false);
    expect(loadStatus(logDir, "sv1")?.merged).toBe(true);
    git(repo, ["checkout", "--", "."]);
    git(repo, ["clean", "-fdq"]);
  });

  it("failing verify restores the checkout exactly and keeps worktree and branch", () => {
    // sv2 starts from a dirty base.txt; capture the state after the snapshot was taken
    const info = snapWorker("sv2");
    const before = state();
    expect(() => mergeWorker(logDir, "sv2", { verify: "false" })).toThrow(/verify failed \(exit 1\): reverted .*worker branch is kept/);
    expect(state()).toBe(before);
    expect(existsSync(join(repo, "src", "sv2.ts"))).toBe(false);
    expect(existsSync(info.dir)).toBe(true);
    expect(git(repo, ["rev-parse", "--verify", info.branch])).toBeTruthy();
    expect(loadStatus(logDir, "sv2")?.merged).toBeFalsy();
    git(repo, ["checkout", "--", "."]);
    git(repo, ["clean", "-fdq"]);
  });

  it("a stub added under src/ fails the scan and restores the checkout", () => {
    const info = snapWorker("sv3", 'export const f = () => { throw new Error("not implemented"); };\n');
    const before = state();
    expect(() => mergeWorker(logDir, "sv3")).toThrow(/stub scan failed: src\/sv3\.ts:1/);
    expect(state()).toBe(before);
    expect(existsSync(info.dir)).toBe(true);
  });
});
