/** pendingResults / pendingGate against throwaway git repos and log dirs only. */

import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPending, pendingGate, pendingResults } from "./pending.js";
import { statusPath } from "./paths.js";
import { nowStamp } from "./status.js";

const sh = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();

let root: string;
let repo: string;
let logDir: string;

function worker(id: string, extra: Record<string, unknown> = {}) {
  const wt = join(root, "wt", id);
  sh(repo, "worktree", "add", "-q", "-b", `worker/${id}`, wt);
  const st = {
    id, pid: 999999, label: `label ${id}`, cwd: repo, state: "done", started: "2026-01-01 00:00:00",
    updated: "2026-01-01 00:00:00", worktreeDir: wt, branch: `worker/${id}`, ...extra,
  };
  writeFileSync(statusPath(logDir, id), JSON.stringify(st));
  return wt;
}

function commit(wt: string, file: string) {
  writeFileSync(join(wt, file), file);
  sh(wt, "add", file);
  sh(wt, "commit", "-q", "-m", file);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-pending-"));
  repo = join(root, "repo");
  logDir = join(root, "logs");
  mkdirSync(repo);
  mkdirSync(logDir);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a"), "a");
  sh(repo, "add", "a");
  sh(repo, "commit", "-q", "-m", "init");
});

describe("pendingResults", () => {
  it("detects unmerged commits", () => {
    commit(worker("w1"), "x");
    const r = pendingResults(logDir, repo);
    expect(r.map((p) => [p.id, p.commits, p.dirty])).toEqual([["w1", 1, 0]]);
    expect(formatPending(r)).toContain("pai worker merge w1");
    const stale = pendingResults(logDir, repo, Date.now() + 48 * 3_600_000);
    expect(formatPending(stale)).toContain("pai worker gc");
  });

  it("detects a dirty worktree and ignores node_modules", () => {
    const wt = worker("w2");
    writeFileSync(join(wt, "u"), "u");
    mkdirSync(join(wt, "node_modules"));
    writeFileSync(join(wt, "node_modules", "m"), "m");
    const r = pendingResults(logDir, repo);
    expect(r.map((p) => [p.commits, p.dirty])).toEqual([[0, 1]]);
  });

  it("ignores branches already cherry-equivalent in HEAD", () => {
    commit(worker("w3"), "y");
    sh(repo, "cherry-pick", "worker/w3");
    expect(pendingResults(logDir, repo)).toEqual([]);
  });

  it("ignores live workers", () => {
    commit(worker("w4", { state: "running", pid: process.pid, started: nowStamp() }), "z");
    expect(pendingResults(logDir, repo)).toEqual([]);
  });

  it("ignores archived workers", () => {
    commit(worker("w5", { archived: "refs/pai-archive/w5" }), "q");
    expect(pendingResults(logDir, repo)).toEqual([]);
  });

  it("scopes to a repo unless none is given", () => {
    commit(worker("w6"), "s");
    const other = join(root, "other");
    mkdirSync(other);
    sh(other, "init", "-q");
    expect(pendingResults(logDir, other)).toEqual([]);
    expect(pendingResults(logDir)).toHaveLength(1);
  });
});

describe("pendingGate", () => {
  const one = [{ id: "w", label: "l", repo: "r", ageMs: 0, age: "0m", commits: 1, dirty: 0 }];
  it("fails with a pending result and names the override", () => {
    const g = pendingGate(one, {});
    expect(g.code).toBe(1);
    expect(g.message).toContain("PAI_ALLOW_PENDING=1");
    expect(g.message).toContain("pai worker merge w");
  });
  it("passes without pending results or with the override", () => {
    expect(pendingGate([], {}).code).toBe(0);
    expect(pendingGate(one, { PAI_ALLOW_PENDING: "1" }).code).toBe(0);
  });
});
