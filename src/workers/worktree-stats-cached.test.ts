import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWorktreesStats, worktreesDir, worktreesStatsCached } from "./worktree.js";


describe("worktreesStatsCached", () => {
  it("returns at once without the size, then serves the du reading from the background refresh", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-wtstats-"));
    const wt = join(worktreesDir(logDir), "w1");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "f.bin"), Buffer.alloc(64 * 1024));
    const first = worktreesStatsCached(logDir);
    expect(first).toEqual({ count: 1, bytes: -1 });
    expect(formatWorktreesStats(first)).toBe("worktrees: 1");
    for (let i = 0; i < 100 && worktreesStatsCached(logDir).bytes < 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(worktreesStatsCached(logDir).bytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  it("is empty without worktrees", () => {
    expect(worktreesStatsCached(mkdtempSync(join(tmpdir(), "pai-wtstats-")))).toEqual({ count: 0, bytes: 0 });
  });
});
