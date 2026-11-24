import { vi, afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClean, scanClean } from "./clean.js";
import { loadStatus, loadStatuses, nowStamp } from "./status.js";
import { archiveWorkerFiles } from "./gc-run.js";
import { eventsPath, statusPath } from "./paths.js";
import { latestMergeGateLog } from "./gate-log.js";
import { recordGitIdentity, restoreGitIdentity } from "./git-identity.js";

// Real git repos / spawned process trees: sized for a loaded machine (load 50 seen), not the 5 s default.
vi.setConfig({ testTimeout: 120_000 });

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
  it("dry run lists and changes nothing; --apply acts on exactly the list", () => {
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

describe("worker gc archive", () => {
  it("moves old finished workers with every sibling; live, young and pending stay; lookups fall back to the archive", () => {
    const { logDir, repo, tree } = fixture();
    const sibs = [".jsonl", ".prompt", ".tldr", ".topic", ".out", ".merge-gate-2026-10-01T00-00-00-000Z.log"];
    const mk = (id: string, extra: Record<string, unknown>, days: number): void => {
      status(logDir, id, extra, days);
      for (const sfx of sibs) {
        writeFileSync(join(logDir, `${id}${sfx}`), "x\n");
        age(join(logDir, `${id}${sfx}`), days);
      }
    };
    mk("w-old", {}, 30);
    mk("w-young", {}, 2);
    mk("w-live", { state: "running", pid: process.pid }, 30);
    const dir = tree("w-pending");
    mk("w-pending", { cwd: repo, worktreeDir: dir, branch: "worker/w-pending" }, 30);
    const month = (t: number): string => `${new Date(t).getFullYear()}-${String(new Date(t).getMonth() + 1).padStart(2, "0")}`;
    const out: string[] = [];
    expect(archiveWorkerFiles(logDir, 14, true, (l) => out.push(l), NOW)).toBe(1);
    expect(existsSync(join(logDir, "w-old.status"))).toBe(true); // dry run moves nothing
    expect(archiveWorkerFiles(logDir, 14, false, (l) => out.push(l), NOW)).toBe(1);
    const arch = join(logDir, "archive", month(NOW - 30 * DAY));
    for (const sfx of [".status", ...sibs]) {
      expect(existsSync(join(arch, `w-old${sfx}`))).toBe(true);
      expect(existsSync(join(logDir, `w-old${sfx}`))).toBe(false);
    }
    for (const id of ["w-young", "w-live", "w-pending"]) expect(existsSync(join(logDir, `${id}.status`))).toBe(true);
    expect(out.join("\n")).toContain("moved w-old");
    // lookups by id fall back to the archive; scans read the top folder only
    expect(loadStatus(logDir, "w-old")?.id).toBe("w-old");
    expect(eventsPath(logDir, "w-old")).toBe(join(arch, "w-old.jsonl"));
    expect(latestMergeGateLog(logDir, "w-old")).toContain(arch);
    expect(loadStatuses(logDir).map((s) => s.id)).not.toContain("w-old");
    expect(loadStatuses(logDir)).toHaveLength(3);
  });
});

describe("archive month listing refresh", () => {
  // the listing cache is keyed by logDir, so each test needs its own temp dir
  let logDir: string;
  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "pai-paths-"));
  });
  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("a month folder created after the first lookup is found via the miss re-read", () => {
    // first lookup of an unrelated id fills the cache with an empty listing
    expect(eventsPath(logDir, "never")).toBe(join(logDir, "never.jsonl"));
    // a separate `pai worker gc` process creates the first archive of a new month
    const month = join(logDir, "archive", "2026-12");
    mkdirSync(month, { recursive: true });
    writeFileSync(join(month, "w.jsonl"), "{}\n");
    // the cached listing would hide it; the miss re-read finds it
    expect(eventsPath(logDir, "w")).toBe(join(month, "w.jsonl"));
  });

  it("a month folder created after the first lookup is found after the TTL", () => {
    vi.useFakeTimers();
    // fill the cache with an empty listing
    expect(eventsPath(logDir, "never")).toBe(join(logDir, "never.jsonl"));
    const month = join(logDir, "archive", "2026-12");
    mkdirSync(month, { recursive: true });
    writeFileSync(join(month, "w.status"), "{}\n");
    // still inside the TTL: the cached (empty) listing is used, nothing found
    vi.advanceTimersByTime(59_000);
    expect(statusPath(logDir, "never")).toBe(join(logDir, "never.status"));
    // past the TTL: the listing is re-read and the new month is seen
    vi.advanceTimersByTime(1_001);
    expect(statusPath(logDir, "w")).toBe(join(month, "w.status"));
    // past the TTL: the listing is re-read and the new month is seen
    vi.advanceTimersByTime(1_001);
    expect(statusPath(logDir, "w")).toBe(join(month, "w.status"));
  });
});

describe("worktree gc output", () => {
  it("archiving a finished worktree writes nothing to stdout (stays pure JSON for --output-format json)", async () => {
    const { logDir, repo, tree } = fixture();
    const dir = tree("w-gc");
    writeFileSync(join(dir, "a.txt"), "x");
    git(dir, "add", "a.txt");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
    status(logDir, "w-gc", { cwd: repo, worktreeDir: dir, branch: "worker/w-gc" }, 3);
    const { gcWorktrees } = await import("./worktree.js");
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
    let res;
    try {
      res = gcWorktrees(logDir, 24, false, NOW);
    } finally {
      console.log = log;
      process.stdout.write = orig;
    }
    expect(res.some((r) => r.archive)).toBe(true);
    expect(out).toEqual([]);
  });
});

describe("git identity backstop", () => {
  it("restores a repo identity a worker changed and logs the worker id", () => {
    const root = mkdtempSync(join(tmpdir(), "pai-gid-"));
    try {
      const repo = join(root, "repo");
      const logDir = join(root, "logs");
      const gc = (...a: string[]): string => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
      execFileSync("git", ["init", "-q", repo]);
      gc("config", "user.name", "Real");
      gc("config", "user.email", "real@example.com");
      recordGitIdentity(logDir, "w1", repo);
      expect(restoreGitIdentity(logDir, "w1", repo)).toBeNull();
      gc("config", "user.name", "bench");
      gc("config", "user.email", "b@b");
      expect(restoreGitIdentity(logDir, "w1", repo)).toContain("worker w1");
      expect(gc("config", "user.name")).toBe("Real");
      expect(gc("config", "user.email")).toBe("real@example.com");
      expect(readFileSync(join(logDir, "git-identity", "alerts.log"), "utf8")).toContain("worker w1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
