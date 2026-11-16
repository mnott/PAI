import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSpawn, escalationReason, escalateOverdue, rerouteWorker, ID_FILE_ENV, RERUN_ID_FILE_ENV, RERUN_OF_ENV, RERUN_OF_FILE_ENV, URGENT_QUEUED_MIN, type ReroutePolicy, type SpawnSpec } from "./reroute.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reroute-"));
  writeFileSync(join(dir, "spec.txt"), "do the thing", "utf8");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const queued = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id: "w1", pid: 4321, label: "l", cwd: "/", term: "", provider: "fakeA", model: "m", state: "queued", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, promptFile: "/nonexistent-prompt", ...over }) as WorkerStatus;

const NOW = Date.parse("2026-11-16T12:00:00Z");
const pol = (queuedMaxMin: number): ReroutePolicy => ({ queuedMaxMin, stallMaxMin: 10, stallFailedCalls: 6 });
const job = (o: Partial<WorkerStatus>): WorkerStatus => ({ id: "w1", state: "queued", spec: "/x", routeWhy: "auto", started: "", capacity: { sinceMs: NOW - 60 * 60_000 }, ...o }) as unknown as WorkerStatus;

describe("escalationReason queued", () => {
  it("queuedMaxMin 0 without urgency: waits", () => {
    expect(escalationReason(job({}), NOW, pol(0))).toBeNull();
  });
  it("queuedMaxMin 0 with urgency: moves after the short fixed wait", () => {
    expect(escalationReason(job({ now: true }), NOW, pol(0))).toContain("queued 60m");
    expect(escalationReason(job({ now: true, capacity: { sinceMs: NOW - 60_000 } } as never), NOW, pol(0))).toBeNull();
    expect(URGENT_QUEUED_MIN).toBe(2);
  });
  it("queuedMaxMin 15 still applies when urgent, never when not", () => {
    expect(escalationReason(job({ now: true }), NOW, pol(15))).not.toBeNull();
    expect(escalationReason(job({ now: true, capacity: { sinceMs: NOW - 5 * 60_000 } } as never), NOW, pol(15))).toBeNull();
    expect(escalationReason(job({}), NOW, pol(15))).toBeNull();
  });
  it("running stall is unchanged", () => {
    const r = job({ state: "running", progressAt: new Date(NOW - 11 * 60_000).toISOString() } as never);
    expect(escalationReason(r, NOW, pol(0))).toContain("no edit or commit");
    expect(escalationReason(job({ state: "running", consecFails: 6 } as never), NOW, pol(0))).toContain("failed tool calls");
  });
});

describe("escalationReason", () => {
  it("an overdue queued job moves; a fresh one and an already rerouted one do not", () => {
    const now = Date.now();
    const held = (sinceMs: number): Partial<WorkerStatus> => ({ capacity: { provider: "fakeA", cap: 1, total: 1, position: 1, elapsedSec: 0, sinceMs } });
    expect(escalationReason(queued({ ...held(now - 16 * 60_000), now: true }), now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 })).toContain("queued 16m");
    expect(escalationReason(queued(held(now - 60_000)), now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 })).toBeNull();
    expect(escalationReason(queued({ ...held(now - 16 * 60_000), now: true, rerouted: "x" }), now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 })).toBeNull();
  });
});

describe("rerouteWorker", () => {
  it("marks a queued run with the hand-over reason before it is stopped (the caller's follower reads it)", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt") }));
    const seen: Array<string | undefined> = [];
    await rerouteWorker("w1", "cloud", {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
      kill: async (id) => {
        seen.push(loadStatus(dir, id)?.rerouted); // at kill time the marker must already stand
        return [];
      },
      spawn: (_s: SpawnSpec) => undefined,
    });
    expect(seen).toEqual(["fakeB: reroute"]);
    expect(loadStatus(dir, "w1")!.rerouted).toBe("fakeB: reroute");
  });

  it("a restart that cannot start leaves the old run queued and unmarked (no silent drop)", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt") }));
    let killed = false;
    await expect(
      rerouteWorker("w1", "cloud", {
        logDir: dir,
        resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
        kill: async () => {
          killed = true;
          return [];
        },
        spawn: () => {
          throw new Error("the restart on fakeB did not start");
        },
      })
    ).rejects.toThrow(/did not start/);
    expect(killed).toBe(false); // the old run was never stopped
    const st = loadStatus(dir, "w1")!;
    expect(st.state).toBe("queued");
    expect(st.rerouted).toBeUndefined(); // a later tick may try again
  });

  // 2026-11-16: the restart defaultSpawn starts must reach the pane launcher like a normal `pai worker run`:
  // the old id travels as PAI_RERUN_OF (and, for a starter that cannot take custom env, as PAI_RERUN_OF_FILE)
  // so the new run is marked a PAI continuation (rerunFromEnv), anchors its pane to the old run's terminal and
  // announces its id at once; an unlaunched restart would be stopped by the pane audit.
  it("defaultSpawn carries the continuation env so the restart launches through the pane launcher", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "running", term: "HOST-TERM" }));
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const fakeStart = ((bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }) => {
      seen.push({ args, env: o.env });
      // the restarted process announces its id on both channels the waiting reroute and --detach read
      writeFileSync(o.env[RERUN_ID_FILE_ENV]!, "w2");
      writeFileSync(o.env[ID_FILE_ENV]!, "w2");
      return 4242;
    }) as typeof import("./reroute.js").spawnSession;
    await defaultSpawn(dir, fakeStart)({ id: "w1", why: "rerouted by escalation", provider: "fakeB", specFile: join(dir, "spec.txt") });
    expect(seen.length).toBe(1);
    const { env } = seen[0]!;
    expect(env[RERUN_OF_ENV]).toBe("w1"); // the new run is the old one's continuation (rerunFromEnv)
    expect(env[RERUN_ID_FILE_ENV]).toBeTruthy(); // the waiting reroute learns the id before it stops the old run
    expect(env[ID_FILE_ENV]).toBe(env[RERUN_ID_FILE_ENV]); // a --detach starter announces on the same file
    expect(env[RERUN_OF_FILE_ENV]).toBeTruthy(); // and carries the old id for that starter (rerunOfFromFile)
    expect(readFileSync(env[RERUN_OF_FILE_ENV]!, "utf8")).toBe("w1");
    expect(seen[0]!.args).toContain("run");
  });

  it("escalateOverdue hands every overdue queued job over once", async () => {
    const now = Date.now();
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), now: true, capacity: { provider: "fakeA", cap: 1, total: 1, position: 1, elapsedSec: 0, sinceMs: now - 16 * 60_000 } }));
    saveStatus(dir, queued({ id: "w2", promptFile: join(dir, "spec.txt"), provider: "fakeB" })); // already on the fallback
    const done = await escalateOverdue([loadStatus(dir, "w1")!, loadStatus(dir, "w2")!], {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
      kill: async () => [],
      spawn: () => undefined,
    }, now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
    expect(done.map((e) => e.id)).toEqual(["w1"]);
    expect(loadStatus(dir, "w1")!.rerouted).toBe("fakeB: queued 16m (operator priority)"); // the marker names where and why it moved
    expect(loadStatus(dir, "w2")!.rerouted).toBeUndefined();
  });
});
