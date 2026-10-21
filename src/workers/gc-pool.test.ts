import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcPoolWorktrees, git, worktreesDir } from "./worktree.js";
import { poolSettings } from "./pool.js";
import { defaultWorkersConfig } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "pai-gcpool-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
mkdirSync(worktreesDir(logDir), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "t@example.invalid"]);
git(repo, ["config", "user.name", "t"]);
writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

describe("no reserve worktrees", () => {
  it("the shipped default keeps no spares, so nothing is created before a worker starts", () => {
    expect(poolSettings(defaultWorkersConfig()).spares).toBe(0);
    expect(existsSync(worktreesDir(logDir)) && readdirSync(worktreesDir(logDir))).toEqual([]);
  });

  it("gc --pool removes an idle spare and a detached slot, keeps one with a process inside", () => {
    const spare = join(worktreesDir(logDir), "spare-1-1");
    git(repo, ["worktree", "add", spare, "-b", "spare/spare-1-1", "main"]);
    const slot = join(logDir, "slots", "local-1");
    mkdirSync(join(logDir, "slots"), { recursive: true });
    git(repo, ["worktree", "add", "--detach", slot, "main"]);
    const busy = join(worktreesDir(logDir), "spare-1-2");
    git(repo, ["worktree", "add", busy, "-b", "spare/spare-1-2", "main"]);

    // the test process itself is exempt from busyPid, so hold the cwd from a child
    
    const child = spawn("sleep", ["30"], { cwd: busy, stdio: "ignore" });
    try {
      const dry = gcPoolWorktrees(logDir, true);
      expect(dry.filter((e) => e.archive).map((e) => e.id).sort()).toEqual(["slot-local-1", "spare-1-1"]);
      expect(existsSync(spare)).toBe(true);

      const res = gcPoolWorktrees(logDir, false);
      expect(res.filter((e) => e.archive).map((e) => e.id).sort()).toEqual(["slot-local-1", "spare-1-1"]);
      expect(res.find((e) => e.id === "spare-1-2")?.skipped).toMatch(/busy/);
      expect(existsSync(spare)).toBe(false);
      expect(existsSync(slot)).toBe(false);
      expect(existsSync(busy)).toBe(true);
      expect(git(repo, ["branch", "--list", "spare/spare-1-1"])).toBe("");
    } finally {
      child.kill();
    }
  });
});
