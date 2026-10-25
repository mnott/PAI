import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveOldStatuses } from "./archive-statuses.js";
import { loadStatuses } from "./status.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const DAY = 24 * 3_600_000;

describe("archiveOldStatuses", () => {
  it("moves old terminal workers with siblings; keeps recent, running and worktree-owning ones", () => {
    const d = mkdtempSync(join(tmpdir(), "arch-"));
    dirs.push(d);
    const now = Date.now();
    const put = (id: string, state: string, ageDays: number, extra: object = {}): void => {
      writeFileSync(join(d, `${id}.status`), JSON.stringify({ id, state, cwd: d, ...extra }));
      writeFileSync(join(d, `${id}.log`), "x");
      const t = new Date(now - ageDays * DAY);
      utimesSync(join(d, `${id}.status`), t, t);
    };
    const wt = join(d, "tree");
    mkdirSync(wt);
    put("old-done", "done", 10);
    put("old-failed", "failed", 30);
    put("new-done", "done", 1);
    put("old-running", "running", 10);
    put("old-tree", "done", 10, { worktreeDir: wt });
    expect(archiveOldStatuses(d, now, { dryRun: true }).sort()).toEqual(["old-done", "old-failed"]);
    expect(existsSync(join(d, "old-done.status"))).toBe(true);
    expect(archiveOldStatuses(d, now).sort()).toEqual(["old-done", "old-failed"]);
    expect(existsSync(join(d, "old-done.status"))).toBe(false);
    expect(existsSync(join(d, "old-done.log"))).toBe(false);
    const month = (id: string): string => {
      const t = new Date(now - (id === "old-done" ? 10 : 30) * DAY);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
    };
    expect(existsSync(join(d, "archive", month("old-done"), "old-done.status"))).toBe(true);
    expect(existsSync(join(d, "archive", month("old-failed"), "old-failed.log"))).toBe(true);
    expect(loadStatuses(d).map((s) => s.id).sort()).toEqual(["new-done", "old-running", "old-tree"]);
  });
});
