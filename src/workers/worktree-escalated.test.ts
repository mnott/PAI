import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeWorker } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";
import { formatPending, pendingResults } from "./pending.js";

const dir = mkdtempSync(join(tmpdir(), "pai-escalated-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
mkdirSync(logDir, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

function status(id: string, extra: Partial<WorkerStatus>): WorkerStatus {
  return {
    id, pid: 999999, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1, ...extra,
  };
}

function task(id: string, extra: Partial<WorkerStatus> = {}): void {
  const base = git(repo, ["rev-parse", "HEAD"]);
  const wt = join(dir, `wt-${id}`);
  git(repo, ["worktree", "add", "-q", "-b", `worker/${id}`, wt, base]);
  writeFileSync(join(wt, `${id}.txt`), `${id}\n`, "utf8");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `${id} work`]);
  saveStatus(logDir, status(id, { branch: `worker/${id}`, worktreeDir: wt, worktreeBase: base, worktreeSnapshot: false, ...extra }));
}

describe("escalated runs", () => {
  it("refuses to merge the old branch while the escalated run is alive", () => {
    task("e1", { escalatedTo: "e1b" });
    saveStatus(logDir, status("e1b", { pid: process.pid, state: "running", started: new Date(Date.now() - process.uptime() * 1000).toISOString().slice(0, 19).replace("T", " "), procStart: Math.round(Date.now() - process.uptime() * 1000) }));
    expect(() => mergeWorker(logDir, "e1")).toThrow(/escalated to e1b, which is still running/);
    expect(git(repo, ["rev-parse", "--verify", "worker/e1"])).toBeTruthy();
    expect(existsSync(join(repo, "e1.txt"))).toBe(false);
    const p = pendingResults(logDir, repo).find((r) => r.id === "e1")!;
    expect(p.escalation).toBe("running");
    expect(formatPending([p])).toContain("do not merge");
  });

  it("shows the old branch as superseded once the escalated run is merged", () => {
    task("e2", { escalatedTo: "e2b" });
    saveStatus(logDir, status("e2b", { merged: true }));
    const p = pendingResults(logDir, repo).find((r) => r.id === "e2")!;
    expect(p.escalation).toBe("superseded");
    expect(formatPending([p])).toContain("pai worker discard e2");
  });

  it("merges normally when the escalated run died unmerged", () => {
    task("e3", { escalatedTo: "e3b" });
    saveStatus(logDir, status("e3b", {}));
    expect(mergeWorker(logDir, "e3")).toContain("merged");
  });
});
