import { execFileSync } from "node:child_process";
/**
 * Tests for killTree: the worker plus every live descendant, leaves first.
 * Status files in a tmp dir and fake pids/signals — nothing is signalled.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, type KillTreeDeps } from "./kill-tree.js";
import { loadStatus, nowStamp, ownsPid, saveStatus, type WorkerStatus } from "./status.js";

function mk(dir: string, id: string, pid: number, over: Partial<WorkerStatus> = {}): void {
  saveStatus(dir, {
    id,
    pid,
    label: id,
    cwd: "/tmp",
    term: "",
    provider: "anthropic",
    model: "m",
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "",
    rc: null,
    secs: null,
    ...over,
  } as WorkerStatus);
}

function fakes(dir: string): { deps: Partial<KillTreeDeps>; signalled: string[] } {
  const signalled: string[] = [];
  const idOf = (pid: number) => `w${pid}`;
  return {
    signalled,
    deps: {
      owns: () => true,
      isAlive: () => false,
      request: () => undefined,
      graceMs: 0,
      signal: (pid) => {
        signalled.push(idOf(pid));
        const s = loadStatus(dir, idOf(pid))!;
        s.state = "killed"; // the run's own SIGTERM handler
        saveStatus(dir, s);
      },
      waitTerminal: async (d, id) => {
        const s = loadStatus(d, id);
        return s && s.state !== "running" ? s : null;
      },
    },
  };
}

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "pai-kill-tree-"));
  mk(dir, "w1", 1);
  mk(dir, "w2", 2, { parent: "w1" });
  mk(dir, "w3", 3, { parent: "w1" });
  mk(dir, "w4", 4, { parent: "w2" });
  return dir;
}

describe("killTree", () => {
  it("kills parent, two children and a grandchild, leaves first", async () => {
    const dir = tree();
    const f = fakes(dir);
    const lines = await killTree(dir, "w1", { deps: f.deps });
    expect(f.signalled).toEqual(["w4", "w2", "w3", "w1"]);
    expect(lines).toHaveLength(4);
    for (const id of ["w1", "w2", "w3", "w4"]) expect(loadStatus(dir, id)!.state).toBe("killed");
  });

  it("--only kills just the parent", async () => {
    const dir = tree();
    const f = fakes(dir);
    const lines = await killTree(dir, "w1", { only: true, deps: f.deps });
    expect(f.signalled).toEqual(["w1"]);
    expect(lines).toHaveLength(1);
    for (const id of ["w2", "w3", "w4"]) expect(loadStatus(dir, id)!.state).toBe("running");
  });

  it("skips an already finished child", async () => {
    const dir = tree();
    mk(dir, "w3", 3, { parent: "w1", state: "done" });
    const f = fakes(dir);
    await killTree(dir, "w1", { deps: f.deps });
    expect(f.signalled).toEqual(["w4", "w2", "w1"]);
    expect(loadStatus(dir, "w3")!.state).toBe("done");
  });

  it("skipRoot ends only the descendants", async () => {
    const dir = tree();
    const f = fakes(dir);
    await killTree(dir, "w1", { skipRoot: true, deps: f.deps });
    expect(f.signalled).toEqual(["w4", "w2", "w3"]);
    expect(loadStatus(dir, "w1")!.state).toBe("running");
  });
});

describe("killTree pid ownership (real ownsPid)", () => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const idFor = (pid: number, d: Date) =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pid}`;
  const ownStart = (): Date => {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    return new Date(out.trim());
  };

  async function run(id: string, started: Date): Promise<{ signalled: number[]; lines: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-own-"));
    mk(dir, id, process.pid, { started: nowStamp(started) });
    const signalled: number[] = [];
    const lines = await killTree(dir, id, {
      deps: { owns: ownsPid, isAlive: () => false, request: () => undefined, graceMs: 0, signal: (pid) => void signalled.push(pid), waitTerminal: async () => null },
    });
    return { signalled, lines };
  }

  it("signals a worker that queued, then got its slot long after the process started", async () => {
    const t = ownStart();
    const r = await run(idFor(process.pid, t), new Date(t.getTime() + 4 * 60_000));
    expect(r.signalled).toContain(process.pid);
  });

  it("does not signal an unrelated process that reused the pid", async () => {
    const t = ownStart();
    const old = new Date(t.getTime() - 3 * 3600_000);
    const r = await run(idFor(process.pid, old), old);
    expect(r.signalled).toEqual([]);
    expect(r.lines[0]).toContain("not this worker any more");
  });
});
