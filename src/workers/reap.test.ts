import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endProcesses, findWorktreeOrphans, isLiveRouter, reapNewSince, reapWorkerProcesses, snapshotWorkerPids } from "./reap.js";

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

  // gc's orphan filter: a process in a spare-<hostPid>-N tree is that host's spare
  // when the host pid is alive and runs worker-pool-host (the command is checked,
  // not only the pid, against pid reuse); spares of a dead or reused host stay orphans
  const isPoolSpare = (dir: string, cmd: string): boolean => {
    const m = /^spare-(\d+)-\d+$/.exec(dir.split("/").pop() ?? "");
    if (!m) return false;
    let cmdOf = "";
    try {
      cmdOf = execFileSync("ps", ["-o", "command=", "-p", m[1]], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      cmdOf = "";
    }
    let alive = false;
    try {
      process.kill(Number(m[1]), 0);
      alive = true;
    } catch {
      /* pid gone */
    }
    return alive && /worker-pool-host|pool-host\b/.test(cmdOf) && /(^|\/)claude(\s|$)/.test(cmd);
  };

  it("a claude in a spare tree of a live pool host is no orphan; of a dead or reused host it is", async () => {
    const host = spawn("sh", ["-c", "exec -a 'node dist/hooks/worker-pool-host.mjs --port 1' sleep 300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const logDir = tmp();
    const spare = join(logDir, "worktrees", `spare-${host.pid}-1`);
    mkdirSync(spare, { recursive: true });
    // a sleeper renamed to `claude`: the spare's own worker process, not a stray shell
    const c = spawn("sh", ["-c", "exec -a claude sleep 300"], { cwd: spare, detached: true, stdio: "ignore" });
    c.unref();
    kids.push(c);
    const pid = c.pid!;
    await new Promise((r) => setTimeout(r, 300));
    const found = findWorktreeOrphans(logDir);
    expect(found.map((o) => o.pid)).toEqual([pid]);
    expect(found[0].cmd).toContain("claude");
    expect(isPoolSpare(spare, found[0].cmd)).toBe(true);
    // a dead host pid: same tree shape, still an orphan
    expect(isPoolSpare(join(logDir, "worktrees", `spare-${2 ** 22}-1`), found[0].cmd)).toBe(false);
    // a reused pid: alive but not a pool host
    expect(isPoolSpare(join(logDir, "worktrees", `spare-${process.pid}-1`), found[0].cmd)).toBe(false);
    process.kill(pid, "SIGKILL");
    process.kill(host.pid!, "SIGKILL");
  });
});

describe("reapNewSince (pooled task end)", () => {
  it("ends only what appeared after the snapshot; the root and earlier processes survive", async () => {
    const dir = tmp();
    const root = sleeper(dir);
    const early = sleeper(dir);
    const before = snapshotWorkerPids({ rootPid: root, dir });
    expect(before.has(early)).toBe(true);
    const late = sleeper(dir);
    const ended = await reapNewSince({ rootPid: root, dir }, before, () => {}, 200);
    expect(ended.map((p) => p.pid)).toEqual([late]);
    expect(await gone(late)).toBe(true);
    expect(alive(early)).toBe(true);
    expect(alive(root)).toBe(true);
  });

  it("leaves alone a process the host started meanwhile in another dir (a spare)", async () => {
    const dir = tmp();
    const other = tmp();
    const root = sleeper(dir);
    const before = snapshotWorkerPids({ rootPid: root, dir });
    const spare = sleeper(other);
    const late = sleeper(dir);
    const ended = await reapNewSince({ rootPid: root, dir }, before, () => {}, 200);
    expect(ended.map((p) => p.pid)).toEqual([late]);
    expect(alive(spare)).toBe(true);
  });

  it("never ends the root pid even when it was not in the snapshot", async () => {
    const dir = tmp();
    const root = sleeper(dir);
    const ended = await reapNewSince({ rootPid: root, dir }, new Set(), () => {}, 200);
    expect(ended.some((p) => p.pid === root)).toBe(false);
    expect(alive(root)).toBe(true);
  });
});
