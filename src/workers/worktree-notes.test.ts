/**
 * Notes/ salvage on worktree removal, against throwaway git repos in tmp dirs.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, discardWorker, git, mergeWorker, recordWorktree } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

function setup(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `pai-notes-${name}-`));
  const repo = join(dir, "repo");
  const logDir = join(dir, "logdir");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, ".gitignore"), "Notes/\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, logDir };
}

function worker(logDir: string, repo: string, id: string, notes: Record<string, string>) {
  const info = addWorktree(logDir, id, repo);
  const st: WorkerStatus = {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
  };
  saveStatus(logDir, st);
  writeFileSync(join(info.dir, "b.txt"), "b\n");
  mkdirSync(join(info.dir, "Notes"), { recursive: true });
  for (const [n, c] of Object.entries(notes)) writeFileSync(join(info.dir, "Notes", n), c);
  git(info.dir, ["add", "-A"]);
  git(info.dir, ["commit", "-q", "-m", "work"]);
  recordWorktree(logDir, st, info, true);
  return info;
}

afterEach(() => vi.restoreAllMocks());

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  return lines;
}

describe("Notes salvage", () => {
  it("copies a note into the original checkout on merge", () => {
    const { repo, logDir } = setup("merge");
    const info = worker(logDir, repo, "n1", { "x.md": "hello\n" });
    const lines = capture();
    mergeWorker(logDir, "n1");
    expect(existsSync(info.dir)).toBe(false);
    expect(readFileSync(join(repo, "Notes", "x.md"), "utf8")).toBe("hello\n");
    expect(lines).toContain("salvaged Notes/x.md from worker n1");
  });

  it("writes a suffixed copy when the name exists with different content", () => {
    const { repo, logDir } = setup("diff");
    mkdirSync(join(repo, "Notes"));
    writeFileSync(join(repo, "Notes", "x.md"), "mine\n");
    worker(logDir, repo, "n2", { "x.md": "theirs\n" });
    const lines = capture();
    mergeWorker(logDir, "n2");
    expect(readFileSync(join(repo, "Notes", "x.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(repo, "Notes", "x.md.n2.md"), "utf8")).toBe("theirs\n");
    expect(lines.some((l) => l.startsWith("salvaged Notes/x.md.n2.md from worker n2"))).toBe(true);
  });

  it("does not duplicate identical content", () => {
    const { repo, logDir } = setup("same");
    mkdirSync(join(repo, "Notes"));
    writeFileSync(join(repo, "Notes", "x.md"), "same\n");
    worker(logDir, repo, "n3", { "x.md": "same\n" });
    const lines = capture();
    mergeWorker(logDir, "n3");
    expect(readdirSync(join(repo, "Notes"))).toEqual(["x.md"]);
    expect(lines.filter((l) => l.startsWith("salvaged"))).toEqual([]);
  });

  it("discard salvages the Notes files before removing the worktree", () => {
    const { repo, logDir } = setup("discard");
    worker(logDir, repo, "n4", { "x.md": "gone\n" });
    const lines = capture();
    discardWorker(logDir, "n4");
    expect(lines.some((l) => l.includes("Notes/x.md"))).toBe(true);
    expect(readFileSync(join(repo, "Notes", "x.md"), "utf8")).toBe("gone\n");
  });
});
