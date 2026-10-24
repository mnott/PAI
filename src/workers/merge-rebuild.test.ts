/**
 * mergeWorker rebuilds dist/ when it lands in the repo the running CLI comes from (injected runner, throwaway repos).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, git, mergeWorker, recordWorktree, type BuildRunner } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";
import { ledgerPath } from "./paths.js";

function setup(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "pai-rebuild-"));
  const repo = join(dir, "repo");
  const logDir = join(dir, "logdir");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const info = addWorktree(logDir, id, repo);
  const st: WorkerStatus = {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-10-24 10:00:00", updated: "2026-10-24 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
  };
  saveStatus(logDir, st);
  writeFileSync(join(info.dir, "b.txt"), "b\n");
  git(info.dir, ["add", "-A"]);
  git(info.dir, ["commit", "-q", "-m", "work"]);
  recordWorktree(logDir, st, info, true);
  return { repo, logDir, other: mkdtempSync(join(tmpdir(), "pai-rebuild-other-")) };
}

afterEach(() => vi.restoreAllMocks());

const okBuild = (): { run: BuildRunner; calls: string[] } => {
  const calls: string[] = [];
  return { calls, run: (cwd) => (calls.push(cwd), { ok: true, ms: 12, tail: "done" }) };
};

describe("merge rebuilds dist", () => {
  it("same repo: builds once, writes the ledger line, prints ok", () => {
    const { repo, logDir } = setup("r1");
    const b = okBuild();
    const out = mergeWorker(logDir, "r1", { verifyTests: false, build: b.run, cliRoot: repo });
    expect(b.calls).toHaveLength(1);
    expect(out).toContain("build: ok (dist rebuilt; the daemon restarts itself on the new build, the router swaps gaplessly within ~30 s)");
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-MERGE-BUILD.*r1.*true/);
  });

  it("other repo: no build", () => {
    const { logDir, other } = setup("r2");
    const b = okBuild();
    const out = mergeWorker(logDir, "r2", { verifyTests: false, build: b.run, cliRoot: other });
    expect(b.calls).toHaveLength(0);
    expect(out).not.toContain("build:");
    expect(existsSync(ledgerPath(logDir)) ? readFileSync(ledgerPath(logDir), "utf8") : "").not.toContain("WORKER-MERGE-BUILD");
  });

  it("--no-build (rebuild: false): no build", () => {
    const { repo, logDir } = setup("r3");
    const b = okBuild();
    mergeWorker(logDir, "r3", { verifyTests: false, build: b.run, cliRoot: repo, rebuild: false });
    expect(b.calls).toHaveLength(0);
  });

  it("build failure: merge kept, message printed", () => {
    const { repo, logDir } = setup("r4");
    const run: BuildRunner = () => ({ ok: false, ms: 5, tail: "x | error TS2322: bad type" });
    const out = mergeWorker(logDir, "r4", { verifyTests: false, build: run, cliRoot: repo });
    expect(out).toContain("build: FAILED — dist unchanged: error TS2322: bad type");
    expect(existsSync(join(repo, "b.txt"))).toBe(true);
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-MERGE-BUILD.*false/);
  });
});
