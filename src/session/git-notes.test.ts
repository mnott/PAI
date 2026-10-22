import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GitNotesError, postCommitHook, removeGitNotes, setupGitNotes, showNote } from "./git-notes.js";

const g = (repo: string, ...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
let repo: string;
let cap: string;

function commit(file: string, msg: string) {
  writeFileSync(join(repo, file), msg);
  g(repo, "add", file);
  g(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);
}
function capture(file: string, session: string, worker?: string) {
  const line = { timestamp: new Date().toISOString(), tool: "Edit", input: { file_path: join(repo, file) }, session, ...(worker ? { workerId: worker } : {}) };
  mkdirSync(cap, { recursive: true });
  writeFileSync(join(cap, "c.jsonl"), JSON.stringify(line) + "\n");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitnotes-"));
  cap = join(mkdtempSync(join(tmpdir(), "gitnotes-cap-")), "raw");
  g(repo, "init", "-q");
  g(repo, "config", "user.name", "t");
  g(repo, "config", "user.email", "t@example.com");
});

describe("git notes", () => {
  it("setup installs the hook and keeps an existing one; remove restores it", () => {
    const hook = join(repo, ".git", "hooks", "post-commit");
    writeFileSync(hook, "#!/bin/sh\necho old\n");
    chmodSync(hook, 0o755);
    expect(setupGitNotes(repo).chained).toBe(true);
    expect(readFileSync(hook, "utf8")).toContain("pai git hook post-commit");
    expect(readFileSync(`${hook}.pre-pai`, "utf8")).toContain("echo old");
    expect(g(repo, "config", "notes.rewriteRef")).toBe("refs/notes/pai");
    expect(removeGitNotes(repo)).toBe(true);
    expect(readFileSync(hook, "utf8")).toContain("echo old");
    expect(existsSync(`${hook}.pre-pai`)).toBe(false);
  });

  it("notes the session that edited the committed file", () => {
    commit("a.txt", "one");
    capture("a.txt", "sess-1", "w-9");
    expect(postCommitHook(repo, cap, {})).toBe(true);
    expect(showNote(repo)).toBe("pai-session: sess-1\npai-worker: w-9");
  });

  it("writes nothing for an unrelated file or during a rebase", () => {
    commit("a.txt", "one");
    capture("b.txt", "sess-2");
    expect(postCommitHook(repo, cap, {})).toBe(false);
    capture("a.txt", "sess-3");
    expect(postCommitHook(repo, cap, { GIT_REFLOG_ACTION: "rebase (pick)" })).toBe(false);
    expect(showNote(repo)).toBeUndefined();
  });

  it("installs a backgrounded hook", () => {
    const { hook } = setupGitNotes(repo);
    expect(readFileSync(hook, "utf8")).toContain("( pai git hook post-commit >/dev/null 2>&1 & )");
  });

  it("refuses to overwrite an existing post-commit.pre-pai", () => {
    const hook = join(repo, ".git", "hooks", "post-commit");
    writeFileSync(hook, "#!/bin/sh\necho foreign\n");
    writeFileSync(`${hook}.pre-pai`, "#!/bin/sh\necho older\n");
    expect(() => setupGitNotes(repo)).toThrow(GitNotesError);
    expect(readFileSync(hook, "utf8")).toContain("foreign");
    expect(readFileSync(`${hook}.pre-pai`, "utf8")).toContain("older");
  });

  it("refuses a core.hooksPath outside .git and writes inside one", () => {
    const outside = mkdtempSync(join(tmpdir(), "gitnotes-hooks-"));
    g(repo, "config", "core.hooksPath", outside);
    expect(() => setupGitNotes(repo)).toThrow(/core\.hooksPath/);
    expect(existsSync(join(outside, "post-commit"))).toBe(false);
    const inside = join(repo, ".git", "myhooks");
    mkdirSync(inside);
    g(repo, "config", "core.hooksPath", inside);
    expect(setupGitNotes(repo).hook).toBe(join(inside, "post-commit"));
  });

  it("skips capture files over 8 MB", () => {
    commit("a.txt", "one");
    capture("a.txt", "sess-big");
    writeFileSync(join(cap, "c.jsonl"), " ".repeat(8 * 1024 * 1024 + 1) + "\n", { flag: "a" });
    expect(postCommitHook(repo, cap, {})).toBe(false);
    expect(showNote(repo)).toBeUndefined();
  });

  it("gives up once the 500 ms budget is spent", () => {
    commit("a.txt", "one");
    capture("a.txt", "sess-late");
    expect(postCommitHook(repo, cap, {}, Date.now() - 10_000)).toBe(false);
    expect(showNote(repo)).toBeUndefined();
  });
});
