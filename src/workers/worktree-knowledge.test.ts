/**
 * Knowledge check + salvage before removal, against throwaway git repos.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, discardWorker, formatKnowledge, gcWorktrees, git, recordWorktree, worktreeKnowledge } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

function setup(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `pai-know-${name}-`));
  const repo = join(dir, "repo");
  const logDir = join(dir, "logdir");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, ".gitignore"), "Notes/\nnode_modules/\n*.log\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, logDir };
}

function worker(logDir: string, repo: string, id: string) {
  const info = addWorktree(logDir, id, repo);
  const st: WorkerStatus = {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
  };
  saveStatus(logDir, st);
  recordWorktree(logDir, st, info, true);
  return info;
}

function ignoredFiles(dir: string) {
  mkdirSync(join(dir, "Notes"), { recursive: true });
  writeFileSync(join(dir, "Notes", "tier.md"), "knowledge\n");
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", "i.js"), "x\n");
  writeFileSync(join(dir, "run.log"), "log\n");
}

afterEach(() => vi.restoreAllMocks());

describe("worktree knowledge", () => {
  it("salvages an ignored Notes file before gc removal, not node_modules", () => {
    const { repo, logDir } = setup("gc");
    const info = worker(logDir, repo, "k1");
    ignoredFiles(info.dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const k = worktreeKnowledge(logDir, "k1", info.dir);
    expect(k.ignored).toEqual(["Notes/tier.md"]);
    const res = gcWorktrees(logDir, 0);
    expect(res[0].archive).toBe("refs/pai-archive/k1");
    expect(existsSync(info.dir)).toBe(false);
    expect(readFileSync(join(repo, "Notes", "tier.md"), "utf8")).toBe("knowledge\n");
    expect(existsSync(join(repo, "node_modules"))).toBe(false);
    expect(existsSync(join(repo, "run.log"))).toBe(false);
  });

  it("archives a dirty worktree instead of losing it", () => {
    const { repo, logDir } = setup("dirty");
    const info = worker(logDir, repo, "k2");
    writeFileSync(join(info.dir, "new.txt"), "wip\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(worktreeKnowledge(logDir, "k2", info.dir).dirty).toContain("new.txt");
    gcWorktrees(logDir, 0);
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["show", "refs/pai-archive/k2:new.txt"])).toBe("wip");
  });

  it("discard salvages Notes first", () => {
    const { repo, logDir } = setup("discard");
    const info = worker(logDir, repo, "k3");
    ignoredFiles(info.dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    discardWorker(logDir, "k3");
    expect(existsSync(info.dir)).toBe(false);
    expect(readFileSync(join(repo, "Notes", "tier.md"), "utf8")).toBe("knowledge\n");
  });

  it("keeps the worktree when salvage is impossible", () => {
    const { repo, logDir } = setup("fail");
    const info = worker(logDir, repo, "k4");
    ignoredFiles(info.dir);
    writeFileSync(join(repo, "Notes"), "a file where the directory must go\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = gcWorktrees(logDir, 0);
    expect(res[0].skipped).toMatch(/cannot salvage Notes\/tier\.md/);
    expect(existsSync(info.dir)).toBe(true);
    expect(() => discardWorker(logDir, "k4")).toThrow(/cannot salvage/);
    expect(existsSync(info.dir)).toBe(true);
  });

  it("detects files written per the transcript that are gone", () => {
    const { repo, logDir } = setup("tr");
    const info = worker(logDir, repo, "k5");
    writeFileSync(join(info.dir, "kept.txt"), "k\n");
    git(info.dir, ["add", "-A"]);
    git(info.dir, ["commit", "-q", "-m", "w"]);
    const ev = (p: string, name = "Write") =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: { file_path: p } }] } });
    writeFileSync(
      join(logDir, "k5.jsonl"),
      [ev(join(info.dir, "gone.md")), ev(join(info.dir, "kept.txt"), "Edit"), ev("/elsewhere/x.md")].join("\n") + "\n"
    );
    const k = worktreeKnowledge(logDir, "k5", info.dir);
    expect(k.missing).toEqual(["gone.md"]);
    expect(k.commits.length).toBe(1);
    expect(formatKnowledge(k).join("\n")).toContain("written but missing: gone.md");
    rmSync(join(logDir, "k5.jsonl"));
  });
});
