import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endProcesses, findWorktreeOrphans, isLiveRouter, reapWorkerProcesses } from "./reap.js";

const kids: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.pid) try { process.kill(k.pid, "SIGKILL"); } catch { /* gone */ }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "reap-")));
  dirs.push(d);
  return d;
};
/** A detached sleeper (own session, own process group) with the given cwd. */
function sleeper(cwd: string): number {
  const c = spawn("sleep", ["300"], { cwd, detached: true, stdio: "ignore" });
  c.unref();
  kids.push(c);
  return c.pid!;
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
};
const gone = async (pid: number): Promise<boolean> => {
  for (const until = Date.now() + 5000; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) if (!alive(pid)) return true;
  return !alive(pid);
};

describe("reap", () => {
  it("ends a detached sleeper with its cwd in the tree and spares one outside", async () => {
    const inside = tmp();
    const outside = tmp();
    const a = sleeper(inside);
    const b = sleeper(outside);
    await new Promise((r) => setTimeout(r, 300));
    const lines: string[] = [];
    const ended = await reapWorkerProcesses({ dir: inside }, (l) => lines.push(l), 500);
    expect(ended.map((p) => p.pid)).toEqual([a]);
    expect(await gone(a)).toBe(true);
    expect(alive(b)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`pid ${a}`);
    expect(lines[0]).toContain("sleep 300");
  });

  it("ends descendants of the root pid", async () => {
    const c = spawn("sh", ["-c", "sleep 300 & wait"], { stdio: "ignore" });
    kids.push(c);
    await new Promise((r) => setTimeout(r, 400));
    const ended = await reapWorkerProcesses({ rootPid: c.pid }, () => undefined, 500);
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(await gone(c.pid!)).toBe(true);
  });

  it("never treats the live router as an orphan; a --port scratch router is one", () => {
    expect(isLiveRouter("node dist/cli/index.mjs router run")).toBe(true);
    expect(isLiveRouter("node dist/cli/index.mjs router run --port 8842")).toBe(false);
  });

  it("gc lists an orphan in a finished worktree and endProcesses ends it", async () => {
    const logDir = tmp();
    const wt = join(logDir, "worktrees", "20260101-000000-1");
    mkdirSync(wt, { recursive: true });
    const pid = sleeper(wt);
    await new Promise((r) => setTimeout(r, 300));
    const found = findWorktreeOrphans(logDir);
    expect(found.map((o) => o.pid)).toEqual([pid]);
    expect(found[0].cmd).toContain("sleep 300");
    await endProcesses(found, () => undefined, 500);
    expect(await gone(pid)).toBe(true);
    expect(findWorktreeOrphans(logDir)).toEqual([]);
  });
});
