import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { saveStatus, type WorkerStatus } from "./status.js";
import { mergeWorker, worktreePath } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function setup(id: string, preexisting?: string): { repo: string; logDir: string } {
  const base = mkdtempSync(join(tmpdir(), "keep-ign-"));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, ".gitignore"), "out/\nnode_modules/\n");
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const logDir = join(base, "logs");
  mkdirSync(join(logDir, "worktrees"), { recursive: true });
  if (preexisting) {
    mkdirSync(join(repo, preexisting), { recursive: true });
    writeFileSync(join(repo, preexisting, "mine.txt"), "mine");
  }
  const dir = worktreePath(logDir, id);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-B", `worker/${id}`, dir, "HEAD"]);
  writeFileSync(join(dir, "w.txt"), "work\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "worker commit"]);
  const files: Record<string, string | Buffer> = {
    "out/run/tree.json": "{}",
    "out/run/annotated.pdf": Buffer.alloc(11 * 1024 * 1024, 1),
    "out/run/cache/a.json": '{"a":1}',
    "out/run/cache/b.json": '{"b":2}',
    "out/run/gpu.txt": "gpu",
    "node_modules/pkg/index.js": "x",
  };
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  const st = {
    id, pid: 99999, label: id, cwd: repo, term: "", provider: "p", model: "m", state: "done",
    started: "2026-11-17 00:00:00", updated: "2026-11-17 00:00:00", turns: 1, tools: 0, last: "", rc: 0, secs: 1,
    branch: `worker/${id}`, worktreeDir: dir, worktreeBase: baseSha, commits: 1,
  } as WorkerStatus;
  saveStatus(logDir, st);
  return { repo, logDir };
}

const opts = { verifyTests: false, rebuild: false, cliRoot: null } as const;

describe("merge keeps a worker's ignored outputs", () => {
  it("moves out/ into the checkout, drops node_modules", async () => {
    const id = "keep1";
    const { repo, logDir } = setup(id);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await mergeWorker(logDir, id, opts);
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(existsSync(worktreePath(logDir, id))).toBe(false);
    expect(statSync(join(repo, "out/run/annotated.pdf")).size).toBe(11 * 1024 * 1024);
    expect(readFileSync(join(repo, "out/run/cache/b.json"), "utf8")).toBe('{"b":2}');
    expect(existsSync(join(repo, "out/run/gpu.txt"))).toBe(true);
    expect(existsSync(join(repo, "node_modules"))).toBe(false);
    expect(lines.some((l) => l.includes("kept ignored out"))).toBe(true);
  });

  it("a colliding out/ goes to leftovers with one naming line", async () => {
    const id = "keep2";
    const { repo, logDir } = setup(id, "out");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await mergeWorker(logDir, id, opts);
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    const left = join(logDir, "leftovers", id);
    expect(readFileSync(join(repo, "out/mine.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(left, "out/run/annotated.pdf"))).toBe(true);
    expect(existsSync(join(left, "node_modules"))).toBe(false);
    expect(lines.filter((l) => l.includes(left) && /MB/.test(l))).toHaveLength(1);
  });
});
