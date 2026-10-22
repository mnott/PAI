import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeWorker, type MergeSettings } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const settings: MergeSettings = {
  generated: ["gen/**"],
  regenerate: `node -e "require('fs').writeFileSync('gen/index.md', 'see: ' + require('fs').readdirSync('gen').filter(f => f !== 'index.md').sort().join(',') + '\\n')"`,
};

/** A repo with a base commit, a worker branch and a diverged main; `edit` applies each side's change. */
function setup(name: string, base: Record<string, string>, work: Record<string, string>, main: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), `pai-autoresolve-${name}-`));
  const repo = join(dir, "repo");
  const logDir = join(dir, "logdir");
  mkdirSync(join(repo, "gen"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  const put = (root: string, files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c, "utf8");
  };
  put(repo, base);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const b = git(repo, ["rev-parse", "HEAD"]);
  const wt = join(dir, "wt");
  git(repo, ["worktree", "add", "-q", "-b", `worker/${name}`, wt, b]);
  put(wt, work);
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "worker change"]);
  put(repo, main);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "main change"]);
  const s: WorkerStatus = {
    id: name, pid: process.pid, label: name, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
    branch: `worker/${name}`, worktreeDir: wt, worktreeBase: b, worktreeSnapshot: false,
  };
  saveStatus(logDir, s);
  return { repo, logDir, wt };
}

describe("merge auto-resolution", () => {
  it("union-merges two pure additions in the same hunk", () => {
    const base = { "reg.ts": "a\nb\n" };
    const { repo, logDir } = setup("u1", base, { "reg.ts": "a\nworker\nb\n" }, { "reg.ts": "a\nmain\nb\n" });
    const out = mergeWorker(logDir, "u1", { merge: settings });
    expect(out).toMatch(/union-merged reg\.ts/);
    expect(readFileSync(join(repo, "reg.ts"), "utf8")).toBe("a\nmain\nworker\nb\n");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ")).toHaveLength(3);
  });

  it("regenerates a generated-only conflict", () => {
    const { repo, logDir } = setup(
      "g1",
      { "gen/index.md": "see: \n" },
      { "gen/index.md": "see: x\n", "gen/x.md": "x\n" },
      { "gen/index.md": "see: y\n", "gen/y.md": "y\n" }
    );
    const out = mergeWorker(logDir, "g1", { merge: settings });
    expect(out).toMatch(/regenerated gen \(3 files\)/);
    expect(readFileSync(join(repo, "gen/index.md"), "utf8")).toBe("see: x.md,y.md\n");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("aborts cleanly when regeneration fails", () => {
    const { repo, logDir } = setup("g2", { "gen/index.md": "1\n" }, { "gen/index.md": "2\n" }, { "gen/index.md": "3\n" });
    const head = git(repo, ["rev-parse", "HEAD"]);
    expect(() => mergeWorker(logDir, "g2", { merge: { ...settings, regenerate: "exit 3" } })).toThrow(/regeneration .*failed/);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("still refuses a real conflict and leaves the repo clean", () => {
    const { repo, logDir } = setup("r1", { "reg.ts": "a\nb\n" }, { "reg.ts": "a\nW\n" }, { "reg.ts": "a\nM\n" });
    const head = git(repo, ["rev-parse", "HEAD"]);
    expect(() => mergeWorker(logDir, "r1", { merge: settings })).toThrow(/git refused the merge of worker\/r1 — conflict in reg\.ts/);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });
});
