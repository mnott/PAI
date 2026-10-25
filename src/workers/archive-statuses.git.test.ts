import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const gitCalls: string[][] = [];
vi.mock("./worktree.js", () => ({
  git: (_cwd: string, args: string[]) => {
    gitCalls.push(args);
    return "worker/keep-me\n";
  },
}));

import { archiveOldStatuses } from "./archive-statuses.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("archiveOldStatuses git use", () => {
  it("looks branches up once per repo for 1000 candidates, keeps a live branch, and caps a pass", () => {
    const d = mkdtempSync(join(tmpdir(), "arch-git-"));
    dirs.push(d);
    const now = Date.now();
    const old = new Date(now - 10 * 24 * 3_600_000);
    for (let i = 0; i < 1000; i++) {
      const id = i === 0 ? "keep-me" : `w${i}`;
      writeFileSync(join(d, `${id}.status`), JSON.stringify({ id, state: "done", cwd: d, branch: `worker/${id}` }));
      utimesSync(join(d, `${id}.status`), old, old);
    }
    gitCalls.length = 0;
    const moved = archiveOldStatuses(d, now, { max: 1000 });
    expect(gitCalls.length).toBe(1);
    expect(moved.length).toBe(999);
    expect(moved).not.toContain("keep-me");
    expect(archiveOldStatuses(d, now, { max: 1000 })).toEqual([]);
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(d, `x${i}.status`), JSON.stringify({ id: `x${i}`, state: "failed", cwd: d }));
      utimesSync(join(d, `x${i}.status`), old, old);
    }
    expect(archiveOldStatuses(d, now, { max: 5 }).length).toBe(5);
  });
});
