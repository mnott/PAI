import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClean, scanClean } from "./clean.js";
import { nowStamp } from "./status.js";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const git = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const DAY = 86_400_000;
const NOW = Date.now();
const stamp = nowStamp(new Date(NOW));

function age(path: string, days: number): void {
  const t = new Date(NOW - days * DAY);
  utimesSync(path, t, t);
}

function status(logDir: string, id: string, extra: Record<string, unknown>, days: number): void {
  const p = join(logDir, `${id}.status`);
  writeFileSync(p, JSON.stringify({ id, pid: 999_999_1, label: id, cwd: "/x", term: "", provider: "p", model: "m", state: "done", started: stamp, updated: stamp, turns: 1, tools: 0, last: "", rc: 0, secs: 1, ...extra }));
  age(p, days);
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pai-clean-")));
  roots.push(root);
  const logDir = join(root, "logs");
  const repo = join(root, "repo");
  mkdirSync(join(logDir, "worktrees"), { recursive: true });
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const tree = (id: string): string => {
    const dir = join(logDir, "worktrees", id);
    git(repo, "worktree", "add", "-q", "-b", `worker/${id}`, dir);
    return dir;
  };
  return { root, logDir, repo, tree };
}

describe("pai clean", () => {
  it("dry run lists and changes nothing; --apply acts on exactly the list", { timeout: 60_000 }, () => {
    const { logDir, repo, tree } = fixture();
    // finished worker with a commit not on main: archived under refs/pai-archive, never lost
    const dir = tree("w-done");
    writeFileSync(join(dir, "a.txt"), "x");
    git(dir, "add", "a.txt");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
    const sha = git(dir, "rev-parse", "HEAD");
    status(logDir, "w-done", { cwd: repo, worktreeDir: dir, branch: "worker/w-done" }, 3);
    // old finished worker's files go to the monthly archive, a young one stays
    status(logDir, "w-old", {}, 30);
    writeFileSync(join(logDir, "w-old.jsonl"), "{}\n");
    age(join(logDir, "w-old.jsonl"), 30);
    status(logDir, "w-young", {}, 1);
    writeFileSync(join(logDir, "w-young.jsonl"), "{}\n");
    // supervision markers of a quiet session
    mkdirSync(join(logDir, "supervision"));
    writeFileSync(join(logDir, "supervision", "sess-1.events"), "e\n");
    age(join(logDir, "supervision", "sess-1.events"), 30);
    writeFileSync(join(logDir, "ledger.log"), "2026-11-01 10:00:00 WORKER-END id=w-old\n");
    age(join(logDir, "ledger.log"), 60);
    const opts = { olderThanHours: 24, now: NOW };

    const before = scanClean(logDir, opts);
    const listed = before.items.map((i) => `${i.category}:${i.owner}`).sort();
    expect(listed).toEqual(["supervision:sess-1", "worker-files:w-old", "worktree:w-done"]);
    // dry run changed nothing
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(logDir, "w-old.jsonl"))).toBe(true);
    expect(existsSync(join(logDir, "supervision", "sess-1.events"))).toBe(true);

    const res = applyClean(logDir, before, opts);
    expect(res.failed).toEqual([]);
    expect(res.done.map((i) => `${i.category}:${i.owner}`).sort()).toEqual(listed);
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, "rev-parse", "refs/pai-archive/w-done")).toBeTruthy();
    git(repo, "merge-base", "--is-ancestor", sha, "refs/pai-archive/w-done");
    expect(existsSync(join(logDir, "w-old.jsonl"))).toBe(false);
    const month = new Date(NOW - 30 * DAY);
    const ym = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
    expect(existsSync(join(logDir, "archive", ym, "w-old.jsonl"))).toBe(true);
    expect(existsSync(join(logDir, "archive", ym, "w-old.status"))).toBe(true);
    expect(existsSync(join(logDir, "w-young.jsonl"))).toBe(true);
    expect(existsSync(join(logDir, "supervision", "sess-1.events"))).toBe(false);
    // the ledger is only appended to, never removed or rewritten
    expect(readFileSync(join(logDir, "ledger.log"), "utf8")).toContain("WORKER-END id=w-old");
    // a second scan has nothing left
    expect(scanClean(logDir, opts).items).toEqual([]);
  });

  it("refuses a live worker's files and a symlinked file, and keeps them", () => {
    const { logDir } = fixture();
    status(logDir, "w-live", { state: "running", pid: process.pid, runPid: process.pid, started: nowStamp(new Date(NOW - 30 * DAY)) }, 30);
    writeFileSync(join(logDir, "w-live.jsonl"), "{}\n");
    status(logDir, "w-link", {}, 30);
    writeFileSync(join(logDir, "target.txt"), "keep");
    symlinkSync(join(logDir, "target.txt"), join(logDir, "w-link.jsonl"));
    const scan = scanClean(logDir, { now: NOW });
    expect(scan.items).toEqual([]);
    const reasons = Object.fromEntries(scan.refused.map((r) => [r.owner, r.reason]));
    expect(reasons["w-live"]).toMatch(/live/);
    expect(reasons["w-link"]).toMatch(/symlink|regular/);
    applyClean(logDir, scan, { now: NOW });
    expect(existsSync(join(logDir, "w-live.jsonl"))).toBe(true);
    expect(existsSync(join(logDir, "w-link.jsonl"))).toBe(true);
    expect(readFileSync(join(logDir, "target.txt"), "utf8")).toBe("keep");
  });

  it("does not list a worktree a live worker owns", () => {
    const { logDir, repo, tree } = fixture();
    const dir = tree("w-run");
    status(logDir, "w-run", { cwd: repo, worktreeDir: dir, branch: "worker/w-run", state: "running", pid: process.pid, runPid: process.pid }, 3);
    const scan = scanClean(logDir, { now: NOW });
    expect(scan.items).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses a recorded build dir that holds a git repo with uncommitted work", () => {
    const { logDir } = fixture();
    const dd = join(tmpdir(), `pai-clean-dd-${process.pid}-${Date.now()}`);
    roots.push(dd);
    mkdirSync(dd, { recursive: true });
    git(dd, "init", "-q");
    writeFileSync(join(dd, "dirty.txt"), "wip");
    age(dd, 5);
    status(logDir, "w-build", {}, 5);
    writeFileSync(join(logDir, "ledger.log"), `2026-11-01 10:00:00 WORKER-BUILD-DIR id=w-build path=${dd}\n`);
    const scan = scanClean(logDir, { now: NOW });
    expect(scan.items).toEqual([]);
    expect(scan.refused.find((r) => r.category === "build-dir")?.reason).toMatch(/uncommitted/);
    applyClean(logDir, scan, { now: NOW });
    expect(existsSync(join(dd, "dirty.txt"))).toBe(true);
  });
});
