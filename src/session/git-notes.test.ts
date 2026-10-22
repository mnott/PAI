import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { postCommitHook, removeGitNotes, setupGitNotes, showNote } from "./git-notes.js";

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
});
