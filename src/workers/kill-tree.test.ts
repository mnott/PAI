import { execFileSync } from "node:child_process";
/**
 * Tests for killTree: the worker plus every live descendant, leaves first.
 * Status files in a tmp dir and fake pids/signals — nothing is signalled.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, killWorker, type KillTreeDeps } from "./kill-tree.js";
import { endLabel, decideEndReason, requestKill, appendStopEvent } from "./endreason.js";
import { eventsPath } from "./paths.js";
import { requestLoopStop } from "./loop-stop.js";
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
        return s && s.state !== "running" && s.state !== "queued" ? s : null;
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

  it("ends a pooled child through its client pid, not the shared slot pid; non-pooled child as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-tree-"));
    mk(dir, "w1", 1);
    mk(dir, "w5", 99, { parent: "w1", pool: { task: 1, slotSession: null, hostPid: 77, clientPid: 5 } });
    mk(dir, "w3", 3, { parent: "w1" });
    const f = fakes(dir);
    const lines = await killTree(dir, "w1", { deps: f.deps });
    expect([...f.signalled].sort()).toEqual(["w1", "w3", "w5"]); // pid 5, never the slot pid 99
    expect(lines.join("\n")).not.toContain("pid 99");
    for (const id of ["w1", "w3", "w5"]) expect(loadStatus(dir, id)!.state).toBe("killed");
  });

  it("skipRoot ends only the descendants", async () => {
    const dir = tree();
    const f = fakes(dir);
    await killTree(dir, "w1", { skipRoot: true, deps: f.deps });
    expect(f.signalled).toEqual(["w4", "w2", "w3"]);
    expect(loadStatus(dir, "w1")!.state).toBe("running");
  });

  it("kill works on a queued worker: signalled, and killed when it never self-reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-queued-"));
    mk(dir, "wq", 11, { state: "queued" });
    mk(dir, "wq-child", 12, { parent: "wq", state: "queued" });
    const f = fakes(dir);
    // no self-report this time: the fake signal only records the signal
    const deps = { ...f.deps, signal: (pid: number) => void f.signalled.push(`w${pid}`) };
    const lines = await killTree(dir, "wq", { deps });
    expect(f.signalled).toEqual(["w12", "w11"]);
    expect(loadStatus(dir, "wq")!.state).toBe("killed");
    expect(loadStatus(dir, "wq-child")!.state).toBe("killed");
    expect(lines.join("\n")).toContain("sent SIGTERM to worker wq");
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

describe("killTree session ownership", () => {
  const owned = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-own-"));
    mk(dir, "w1", 1, { session: { id: "u1", name: "PAI" } as WorkerStatus["session"] });
    return dir;
  };
  const env = (name: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PAI_SESSION_NAME: name, ...extra });

  it("owner session may kill", async () => {
    const dir = owned();
    const f = fakes(dir);
    await killTree(dir, "w1", { deps: f.deps, caller: { env: env("PAI"), force: false } });
    expect(f.signalled).toEqual(["w1"]);
  });

  it("another session is refused, nothing signalled", async () => {
    const dir = owned();
    const f = fakes(dir);
    await expect(killTree(dir, "w1", { deps: f.deps, caller: { env: env("MyApp"), force: false } })).rejects.toThrow(
      "worker w1 belongs to session PAI; refused (use --force from the operator's terminal or that session)"
    );
    expect(f.signalled).toEqual([]);
  });

  it("--force from a non-worker is allowed and flagged; from a worker it is refused", async () => {
    const dir = owned();
    const f = fakes(dir);
    const forced: (boolean | undefined)[] = [];
    f.deps.request = (_d, _l, _i, fo) => void forced.push(fo);
    await killTree(dir, "w1", { deps: { ...f.deps, notifyOwner: async () => undefined }, reason: "test", caller: { env: env("MyApp"), force: true } });
    expect(f.signalled).toEqual(["w1"]);
    expect(forced).toEqual([true]);
    const dir2 = owned();
    await expect(
      killTree(dir2, "w1", { deps: fakes(dir2).deps, caller: { env: env("MyApp", { PAI_WORKER: "1" }), force: true } })
    ).rejects.toThrow("--force");
  });

  it("ownerless worker and internal callers are unaffected", async () => {
    const dir = tree();
    const f = fakes(dir);
    await killTree(dir, "w1", { deps: f.deps, caller: { env: env("MyApp"), force: false } });
    expect(f.signalled.length).toBe(4);
    const dir2 = owned();
    const f2 = fakes(dir2);
    await killTree(dir2, "w1", { deps: f2.deps });
    expect(f2.signalled).toEqual(["w1"]);
  });
});

describe("killTree records who stopped a worker and why", () => {
  const readEvents = (dir: string, id: string) =>
    readFileSync(eventsPath(dir, id), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  function owned(): string {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-why-"));
    mk(dir, "w1", 1, { label: "MyApp", session: { id: "SESS-OWNER", name: "owner" } });
    return dir;
  }
  const other = { CLAUDE_CODE_SESSION_ID: "224db3e0" } as NodeJS.ProcessEnv;

  it("forced kill by another session: final event, status and owner message carry killer and reason", async () => {
    const dir = owned();
    const f = fakes(dir);
    const sent: string[][] = [];
    const reqs: unknown[][] = [];
    await killTree(dir, "w1", {
      caller: { env: other, force: true },
      reason: "stuck in a loop",
      deps: { ...f.deps, request: (...a) => void reqs.push(a), notifyOwner: async (o, t) => void sent.push([o, t]) },
    });
    const last = readEvents(dir, "w1").at(-1);
    expect(last).toMatchObject({ type: "worker-stopped", killed_by: "claude-session:224db3e0", forced: true, reason: "stuck in a loop" });
    expect(reqs[0]).toEqual([expect.anything(), expect.anything(), "w1", true, "claude-session:224db3e0", "stuck in a loop"]);
    expect(sent).toEqual([["SESS-OWNER", "worker w1 (MyApp) stopped by claude-session:224db3e0: stuck in a loop"]]);
  });

  it("--force on another session's worker without a reason is refused; the owner needs none", async () => {
    const dir = owned();
    const f = fakes(dir);
    await expect(killTree(dir, "w1", { caller: { env: other, force: true }, deps: f.deps })).rejects.toThrow(/--reason/);
    expect(f.signalled).toEqual([]);
    const sent: string[] = [];
    await killTree(dir, "w1", {
      caller: { env: { PAI_SESSION_NAME: "owner" } as NodeJS.ProcessEnv, force: true },
      deps: { ...f.deps, notifyOwner: async (_o, t) => void sent.push(t) },
    });
    expect(sent).toEqual([]); // owner killing its own worker: no message
    expect(readEvents(dir, "w1").at(-1)).toMatchObject({ killed_by: "owner", forced: true });
  });

  it("guard and deadline kills record their name, reason and tell the owner", async () => {
    for (const by of ["loop-guard", "deadline"]) {
      const dir = owned();
      const f = fakes(dir);
      const sent: string[] = [];
      await killTree(dir, "w1", { by, reason: `${by} fired`, deps: { ...f.deps, notifyOwner: async (_o, t) => void sent.push(t) } });
      expect(readEvents(dir, "w1").at(-1)).toMatchObject({ killed_by: by, forced: false, reason: `${by} fired` });
      expect(sent).toEqual([`worker w1 (MyApp) stopped by ${by}: ${by} fired`]);
    }
  });

  it("status of a worker that never self-reports shows killer, force and reason", async () => {
    const dir = owned();
    const f = fakes(dir);
    const deps = { ...f.deps, signal: () => undefined, notifyOwner: async () => undefined };
    await killTree(dir, "w1", { caller: { env: other, force: true }, reason: "why", deps });
    const st = loadStatus(dir, "w1")!;
    expect(st).toMatchObject({ endBy: "claude-session:224db3e0", endKillReason: "why", endForced: true });
    expect(endLabel(st)).toBe("pai-worker-kill by claude-session:224db3e0 (forced): why");
  });
});

describe("killWorker requires a reason from a non-interactive caller", () => {
  const env = { PAI_SESSION_NAME: "owner" } as NodeJS.ProcessEnv;
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-reason-"));
    mk(dir, "w1", 1, { session: { id: "SESS-OWNER", name: "owner" } });
    return { dir, f: fakes(dir) };
  };

  it("no TTY and no reason: refused, nothing killed", async () => {
    const { dir, f } = setup();
    await expect(killWorker(dir, "w1", { caller: { env, force: false }, deps: f.deps })).rejects.toThrow(
      "pai worker kill: --reason is required (it goes into the ledger and pai worker ps)"
    );
    await expect(killWorker(dir, "w1", { caller: { env, force: false }, reason: "  ", deps: f.deps })).rejects.toThrow(/--reason is required/);
    expect(f.signalled).toEqual([]);
    expect(loadStatus(dir, "w1")!.state).toBe("running");
  });

  it("no TTY with a reason: recorded as given", async () => {
    const { dir, f } = setup();
    const reqs: unknown[][] = [];
    await killWorker(dir, "w1", { caller: { env, force: false }, reason: "stuck loop", deps: { ...f.deps, request: (...a) => void reqs.push(a) } });
    // the run's own exit writes endKillReason from the kill request; killWorker hands the reason to that request
    expect(reqs).toEqual([[expect.anything(), expect.anything(), "w1", false, "owner", "stuck loop"]]);
    expect(loadStatus(dir, "w1")!.state).toBe("killed");
  });

  it("TTY without a reason: allowed", async () => {
    const { dir, f } = setup();
    await killWorker(dir, "w1", { caller: { env, force: false }, interactive: true, deps: f.deps });
    expect(f.signalled).toEqual(["w1"]);
  });
});

describe("stop reason through the kill marker and the loop guard", () => {
  it("marker carries forced and reason into the end decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-marker-"));
    requestKill(dir, join(dir, "ledger"), "w9", "someone", true, "because");
    const end = decideEndReason({ logDir: dir, id: "w9", signal: "SIGTERM" });
    expect(end).toMatchObject({ reason: "pai-worker-kill", by: "someone", killReason: "because", forced: true });
    expect(end.note).toContain("because");
  });

  it("loop-stop writes the final event", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-loop-"));
    requestLoopStop(dir, "w8", "same call 20x", { kill: () => undefined, claudePid: () => undefined });
    const last = JSON.parse(readFileSync(eventsPath(dir, "w8"), "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ type: "worker-stopped", killed_by: "loop-guard", reason: "same call 20x" });
    appendStopEvent(dir, "w8", { killed_by: "gc", forced: false, reason: "r" });
  });
});

describe("a queued run whose id is older than its process (escalation re-run in the same process)", () => {
  it("is live and kill stops its waiting caller", async () => {
    const { spawn } = await import("node:child_process");
    const { isLive } = await import("./status.js");
    const dir = mkdtempSync(join(tmpdir(), "kill-queued-"));
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const old = new Date(Date.now() - 20 * 60_000);
    const p = (n: number) => String(n).padStart(2, "0");
    const id = `${old.getFullYear()}${p(old.getMonth() + 1)}${p(old.getDate())}-${p(old.getHours())}${p(old.getMinutes())}${p(old.getSeconds())}-${child.pid}`;
    // the escalated run: fresh id/started stamp, process started minutes before
    mk(dir, id, child.pid!, { state: "queued", id, procStart: Date.now() - 500, started: nowStamp() });
    const s = loadStatus(dir, id)!;
    expect(isLive(s)).toBe(true);
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    const lines = await killTree(dir, id, { deps: { graceMs: 200 } });
    await exited;
    expect(lines.join("\n")).toContain("SIGTERM");
    expect(loadStatus(dir, id)!.state).toBe("killed");
  });
});

describe("killTree pooled worker", () => {
  const pooled = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-pool-"));
    mk(dir, "p1", 1, { pool: { task: 1, slotSession: "s", hostPid: 2, clientPid: 3, slot: "/tmp/slot-x" } });
    return dir;
  };
  const base = { request: () => undefined, graceMs: 0, owns: () => false, isAlive: () => false, waitTerminal: async () => null };

  it("asks the host to stop the task and marks it killed", async () => {
    const dir = pooled();
    const asked: string[] = [];
    const lines = await killTree(dir, "p1", {
      deps: { ...base, signal: () => undefined, stopPooled: async (s) => (asked.push(s.id), true), slotPids: () => [] },
    });
    expect(asked).toEqual(["p1"]);
    expect(lines[0]).not.toContain("not this worker any more");
    expect(loadStatus(dir, "p1")?.state).toBe("killed");
  });

  it("falls back to the slot-cwd process when the host is unreachable", async () => {
    const dir = pooled();
    const signalled: number[] = [];
    const lines = await killTree(dir, "p1", {
      deps: { ...base, signal: (p) => void signalled.push(p), stopPooled: async () => false, slotPids: (slot) => (slot === "/tmp/slot-x" ? [777] : []) },
    });
    expect(signalled).toContain(777);
    expect(lines[0]).not.toContain("not this worker any more");
    expect(loadStatus(dir, "p1")?.state).toBe("killed");
  });

  it("marks lost only when neither host nor slot process exists", async () => {
    const dir = pooled();
    await killTree(dir, "p1", { deps: { ...base, signal: () => undefined, stopPooled: async () => false, slotPids: () => [] } });
    expect(loadStatus(dir, "p1")?.state).toBe("lost");
  });
});
