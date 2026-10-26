import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSharedCheckout } from "./shared-checkout.js";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "ignore" });
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "shco-")));

function repo(): string {
  const d = tmp();
  sh(d, "init", "-q");
  sh(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i");
  return d;
}

function status(logDir: string, id: string, cwd: string, state = "running") {
  writeFileSync(join(logDir, `${id}.status`), JSON.stringify({ id, pid: process.pid, cwd, state, started: new Date().toISOString() }));
}

describe("isSharedCheckout", () => {
  it("private clone with only this worker is not shared", () => {
    const d = repo();
    const logs = tmp();
    status(logs, "me", d);
    expect(isSharedCheckout({ cwd: d, selfId: "me", logDir: logs })).toBe(false);
  });

  it("a second running worker in the same dir makes it shared", () => {
    const d = repo();
    const logs = tmp();
    status(logs, "me", d);
    status(logs, "other", d);
    expect(isSharedCheckout({ cwd: d, selfId: "me", logDir: logs })).toBe(true);
  });

  it("a finished worker in the same dir does not", () => {
    const d = repo();
    const logs = tmp();
    status(logs, "other", d, "done");
    expect(isSharedCheckout({ cwd: d, selfId: "me", logDir: logs })).toBe(false);
  });

  it("a checkout with linked worktrees is shared", () => {
    const d = repo();
    const logs = tmp();
    mkdirSync(join(logs, "x"));
    sh(d, "worktree", "add", "-q", join(logs, "x", "wt"), "-b", "wt");
    expect(isSharedCheckout({ cwd: d, selfId: "me", logDir: logs })).toBe(true);
  });

  it("a checkout with a remote is shared", () => {
    const d = repo();
    sh(d, "remote", "add", "origin", "https://example.invalid/r.git");
    expect(isSharedCheckout({ cwd: d, selfId: "me", logDir: tmp() })).toBe(true);
  });

  it("fails closed when not a git dir or logDir unknown", () => {
    expect(isSharedCheckout({ cwd: tmp(), logDir: tmp() })).toBe(true);
    expect(isSharedCheckout({ cwd: repo(), logDir: null })).toBe(true);
  });
});

describe("isSharedCheckout: bench trees dir", () => {
  const cloneUnder = (bench: string, name: string): string => {
    const origin = repo();
    const dir = join(bench, name);
    execFileSync("git", ["clone", "-q", origin, dir], { stdio: "ignore" });
    return realpathSync(dir);
  };

  it("a standalone clone with a remote under the bench dir is private; the same clone elsewhere is shared", () => {
    const bench = tmp();
    const logs = tmp();
    const clone = cloneUnder(bench, "key-task1");
    status(logs, "me", clone);
    expect(isSharedCheckout({ cwd: clone, selfId: "me", logDir: logs, benchTreesDir: bench })).toBe(false);
    expect(isSharedCheckout({ cwd: clone, selfId: "me", logDir: logs, benchTreesDir: tmp() })).toBe(true);
    expect(isSharedCheckout({ cwd: clone, selfId: "me", logDir: logs })).toBe(true);
  });

  it("the main checkout is still shared when a bench dir is configured", () => {
    const bench = tmp();
    const logs = tmp();
    const main = cloneUnder(tmp(), "proj");
    expect(isSharedCheckout({ cwd: main, selfId: "me", logDir: logs, benchTreesDir: bench })).toBe(true);
  });

  it("a bench clone another worker registered as its tree is shared", () => {
    const bench = tmp();
    const logs = tmp();
    const clone = cloneUnder(bench, "key-task2");
    status(logs, "other", clone, "done");
    expect(isSharedCheckout({ cwd: clone, selfId: "me", logDir: logs, benchTreesDir: bench })).toBe(true);
  });
});
