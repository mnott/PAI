import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuild } from "./gate.js";
import { enqueue, listBuilds, patchTicket, tryStart } from "./queue.js";
import { buildStallTick, directAlert, realReleaseDeps, stallTick, type StallDeps, type StallReleaseDeps, type StallState } from "./stall.js";

// 2026-11-17: a mac build lock was held 3 h 45 min with no output while the machine ran at load ~160;
// every worker of the project queued behind it and failed, and the stall alert reached the session 10 h late.
// Injected clock and fake process probe: no real sleeps, no load.

const alive = () => true;
let clock = 1_000_000;
let dir = "";
const q = () => ({ isAlive: alive, now: () => clock });

beforeEach(() => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), "stall-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function holder(key = "k"): Promise<string> {
  const t = await enqueue(dir, { pid: process.pid, label: "mac build", session: "s", cmd: "xcodebuild", mode: "delta", key }, q());
  expect(await tryStart(dir, t.id, 1, q())).toBe(true);
  await patchTicket(dir, t.id, { pgid: 4242 });
  return t.id;
}

const mkDeps = (over: Partial<StallDeps>, size: () => number, events: string[]): StallDeps => ({
  size,
  lastLine: () => "last",
  now: () => clock,
  log: (l) => events.push(l),
  notify: async (_t, text) => void events.push("NOTIFY " + text),
  busy: async () => ({ busy: false, why: "" }),
  ...over,
});

type Rel = StallReleaseDeps & { killed: number[] };
const release = (over: Partial<StallReleaseDeps> = {}): Rel => {
  const killed: number[] = [];
  return { minutes: 15, cpuPct: () => 0.2, capture: async () => "saved", kill: async (r) => void killed.push(r), ledger: () => undefined, ...over, killed };
};

const tick = async (state: StallState, d: StallDeps) => stallTick(dir, await listBuilds(dir, { isAlive: alive }), 5, state, d);

describe("stalled lock release", () => {
  it("releases a silent idle holder after the threshold, kills the exact tree and frees the slot", async () => {
    const id = await holder();
    const killed: number[] = [];
    const ledger: string[] = [];
    const rel: StallReleaseDeps = {
      minutes: 15,
      cpuPct: () => 0.2,
      capture: async () => "saved",
      kill: async (r) => void killed.push(r),
      ledger: (e, kv) => void ledger.push(`${e} pid=${kv.pid} cmd=${kv.cmd}`),
    };
    const ev: string[] = [];
    const d = mkDeps({ release: rel }, () => 0, ev);
    const state: StallState = new Map();
    await tick(state, d);
    clock += 14 * 60_000;
    await tick(state, d);
    expect(killed).toEqual([]); // below the threshold: flagged only
    clock += 2 * 60_000;
    await tick(state, d);
    expect(killed).toEqual([4242]);
    expect(ledger).toEqual(["BUILD-STALL-RELEASE pid=4242 cmd=xcodebuild"]);
    expect(ev.some((e) => /build lock released: .* stalled 16 min without output; retry/.test(e))).toBe(true);
    expect((await listBuilds(dir, { isAlive: alive })).find((t) => t.id === id)?.state).toBe("superseded");
    const w = await enqueue(dir, { pid: process.pid, label: "w", session: "s2", cmd: "x", mode: "delta", key: "k" }, q());
    expect(await tryStart(dir, w.id, 1, q())).toBe(true);
  });

  it("a finished job (tree gone) gets its ticket cleaned with a finished message, not a stall release", async () => {
    const id = await holder();
    const rel = release({ cpuPct: () => null });
    const ev: string[] = [];
    const d = mkDeps({ release: rel }, () => 0, ev);
    const state: StallState = new Map();
    await tick(state, d);
    clock += 16 * 60_000;
    await tick(state, d);
    expect(rel.killed).toEqual([]);
    expect((await listBuilds(dir, { isAlive: alive })).find((t) => t.id === id)).toBeUndefined();
    expect(ev.some((e) => /finished \(process tree gone\); ticket cleaned/.test(e))).toBe(true);
    expect(ev.some((e) => /stalled|killed/.test(e))).toBe(false);
  });

  it("a silent job whose tree is busy by cpu-time growth (idle %cpu) is not killed and its quiet window restarts", async () => {
    const id = await holder();
    const rel = release({ cpuPct: () => 0.1 });
    const d = mkDeps({ release: rel, busy: async () => ({ busy: true, why: "cpu +3s" }) }, () => 0, []);
    const state: StallState = new Map();
    for (let i = 0; i < 8; i++) {
      clock += 5 * 60_000;
      await tick(state, d);
    }
    expect(rel.killed).toEqual([]);
    expect((await listBuilds(dir, { isAlive: alive })).find((t) => t.id === id)?.state).toBe("running");
    // the tree goes idle: the window counts from the last busy sample, so no instant kill
    const idle = mkDeps({ release: rel }, () => 0, []);
    await tick(state, idle);
    expect(rel.killed).toEqual([]);
  });

  it("a real stall writes the diagnosis file named in the message", async () => {
    await holder();
    const ev: string[] = [];
    const rel = { ...realReleaseDeps(dir, 15, () => undefined), cpuPct: () => 0.1, kill: async () => undefined };
    const d = mkDeps({ release: rel }, () => 0, ev);
    const state: StallState = new Map();
    await tick(state, d);
    clock += 16 * 60_000;
    await tick(state, d);
    const m = ev.join("\n").match(/diagnosis: (\S+)\)/);
    expect(m).not.toBeNull();
    expect(existsSync((m as RegExpMatchArray)[1])).toBe(true);
  });

  it("never releases an active build with output, nor a silent but CPU-busy tree", async () => {
    const id = await holder();
    const rel = release();
    let size = 0;
    const d = mkDeps({ release: rel }, () => (size += 100), []);
    const state: StallState = new Map();
    for (let i = 0; i < 20; i++) {
      clock += 5 * 60_000;
      await tick(state, d);
    }
    const busy = release({ cpuPct: () => 300 });
    const d2 = mkDeps({ release: busy }, () => 5, []);
    const st2: StallState = new Map();
    for (let i = 0; i < 6; i++) {
      clock += 5 * 60_000;
      await tick(st2, d2);
    }
    expect(rel.killed).toEqual([]);
    expect(busy.killed).toEqual([]);
    expect((await listBuilds(dir, { isAlive: alive })).find((t) => t.id === id)?.state).toBe("running");
  });

  it("retries an alert that did not get through until it is delivered, then stops", async () => {
    await holder();
    let ok = false;
    const sent: string[] = [];
    const d = mkDeps({ notify: async (_t, x) => (sent.push(x), ok) }, () => 0, []);
    const state: StallState = new Map();
    await tick(state, d);
    clock += 6 * 60_000;
    await tick(state, d);
    expect(sent).toHaveLength(1);
    ok = true;
    clock += 30_000;
    await tick(state, d);
    expect(sent).toHaveLength(2);
    clock += 30_000;
    await tick(state, d);
    expect(sent).toHaveLength(2);
  });
});

describe("stall alert path", () => {
  it("goes straight to the owner's session with noReply (no router, no messenger chain)", async () => {
    const calls: unknown[][] = [];
    const ok = await directAlert("uuid-1", "stalled", async (...a) => (calls.push(a), { ok: true }));
    expect(ok).toBe(true);
    expect(calls).toEqual([["uuid-1", "stalled", 10_000, { noReply: true }]]);
  });
  it("reports not delivered (so it is retried) without a target or on a failed send", async () => {
    expect(await directAlert(undefined, "x", async () => ({ ok: true }))).toBe(false);
    expect(await directAlert("t", "x", async () => ({ ok: false }))).toBe(false);
  });
});

describe("waiter timeout", () => {
  it("gives up after maxWait with exit 6 naming the holder, its age and last output", async () => {
    const hold = await holder();
    const out: string[] = [];
    let t = clock;
    const code = await runBuild({
      dir,
      command: ["true"],
      slots: 1,
      key: "k",
      maxWaitMs: 30 * 60_000,
      pollMs: 1,
      heartbeatMs: 5 * 60_000,
      out: (l) => out.push(l),
      callerGone: () => false,
      deps: { isAlive: alive, now: () => (t += 60_000) },
    });
    expect(code).toBe(6);
    const line = out[out.length - 1];
    expect(line).toMatch(/gave up after waiting 3\dm/);
    expect(line).toContain(hold);
    expect(line).toMatch(/for \d+m/);
    expect(line).toMatch(/last output never/);
  });
});

describe("daemon tick reentrancy", () => {
  it("a tick still in flight is never stacked: the overlapping call returns [] and a later one runs again", async () => {
    await holder();
    const tickets = await listBuilds(dir, { isAlive: alive });
    let busyCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Partial<StallDeps> = {
      size: () => 0,
      lastLine: () => "last",
      now: () => clock,
      log: () => undefined,
      busy: async () => {
        busyCalls++;
        await gate;
        return { busy: true, why: "slow" };
      },
    };
    const tell = async () => undefined;
    await buildStallTick(dir, 5, tell, tickets, slow); // first sight: records size
    clock += 6 * 60_000;
    const first = buildStallTick(dir, 5, tell, tickets, slow);
    await new Promise((r) => setTimeout(r, 20));
    expect(busyCalls).toBe(1);
    expect(await buildStallTick(dir, 5, tell, tickets, slow)).toEqual([]);
    expect(busyCalls).toBe(1);
    release();
    await first;
    clock += 6 * 60_000;
    await buildStallTick(dir, 5, tell, tickets, slow);
    expect(busyCalls).toBe(2);
  });
});
