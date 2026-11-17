import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSpawn, endContinuedOrigins, escalationReason, escalateOverdue, rerouteWorker, ID_FILE_ENV, RERUN_ID_FILE_ENV, RERUN_OF_ENV, RERUN_OF_FILE_ENV, URGENT_QUEUED_MIN, type ReroutePolicy, type SpawnSpec } from "./reroute.js";
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

  // 2026-11-17: the restart announced only at its real start, but the queue-announce flag was set anyway, so no
  // start announced it: the reroute reported "did not start" and never stopped the origin. The reroute must stop
  // a queued and a running origin once its restart announced.
  it.each(["queued", "running"] as const)("a %s origin is stopped once the restart announced", async (state) => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state }));
    const killed: string[] = [];
    const r = await rerouteWorker("w1", "cloud", {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
      kill: async (id) => { killed.push(id); return []; },
      spawn: (_s: SpawnSpec) => undefined, // resolves = the restart announced its id
    });
    expect(killed).toEqual(["w1"]);
    expect(r.was).toBe(state);
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

describe("one live fall-through per origin", () => {
  const run = async (stale: WorkerStatus[], spawned: string[]) =>
    escalateOverdue(stale, { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, Date.now(), { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
  const origin = () => queued({ promptFile: join(dir, "spec.txt"), now: true, capacity: { provider: "fakeA", cap: 1, total: 1, position: 1, elapsedSec: 0, sinceMs: Date.now() - 16 * 60_000 } });

  it("three ticks on a stale cached view produce one fall-through", async () => {
    saveStatus(dir, origin());
    const stale = [loadStatus(dir, "w1")!]; // never refreshed: no rerouted mark in it
    const spawned: string[] = [];
    for (let i = 0; i < 3; i++) await run(stale, spawned);
    expect(spawned).toEqual(["w1"]);
  });

  it("after a restart a running fall-through blocks the reroute (marker lost too)", async () => {
    saveStatus(dir, origin());
    saveStatus(dir, queued({ id: "w9", state: "running", provider: "fakeB", fallThroughOf: "w1", updated: new Date().toISOString().replace("T", " ") }));
    const spawned: string[] = [];
    const done = await run([loadStatus(dir, "w1")!], spawned);
    expect(spawned).toEqual([]);
    expect(done).toEqual([]);
  });
});

// 2026-11-17: the queued origin 015238-83106 was rerouted four times — each fall-through finished rc=0 with a
// committed fix, but the origin stayed queued, and once the "finished within the last few minutes" window passed
// it was rerouted again. A successful fall-through now ENDS its origin: out of the provider queue as continued,
// never rerouted again; a failed one leaves it queued for one more reroute after its recent window.
describe("a finished fall-through ends its queued origin", () => {
  const stale = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
    ({ id: "w1", state: "queued", provider: "fakeA", spec: join(dir, "spec.txt"), routeWhy: "auto", now: true, rerouted: "fakeB: queued 15m (operator priority)", fallThroughTo: "w2", started: "", updated: "", capacity: { provider: "fakeA", cap: 1, total: 1, position: 1, elapsedSec: 0, sinceMs: Date.now() - 16 * 60_000 }, ...over }) as unknown as WorkerStatus;
  // saveStatus re-stamps `updated` on every write, so an aged end time is written back with a Date of that
  // age (saveStatus stamps `updated` from its date argument): the fall-through ended 6 min ago, past the recent window.
  const AGO = 6 * 60_000;
  const ft = (state: string, rc: number | null): WorkerStatus =>
    ({ id: "w2", pid: 9999, label: "l2", cwd: "/", term: "", provider: "fakeB", model: "m", state, started: "", updated: "", turns: 1, tools: 0, last: "", rc, secs: 40, fallThroughOf: "w1" }) as unknown as WorkerStatus;

  it("a done rc=0 fall-through ends the origin as continued and removes its queue ticket", () => {
    saveStatus(dir, stale());
    saveStatus(dir, ft("done", 0), new Date(Date.now() - AGO), true); // ended 6 min ago: past the recent window
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    writeFileSync(join(dir, "queue", "fakeA", "w1"), `${process.pid} front @1`); // its place in line (a parked/preempted wait)
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir, Date.now() + 6 * 60_000)).toEqual(["w1"]);
    const st = loadStatus(dir, "w1")!;
    expect(st.state).toBe("killed"); // terminal: the caller's wait resolves, supervision files it
    expect(st.rc).toBe(143);
    expect(st.continuedBy).toBe("w2"); // the hand-off names who did the work
    expect(st.last).toContain("continued by w2");
    expect(existsSync(join(dir, "queue", "fakeA", "w1"))).toBe(false); // out of the provider queue
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toContain("WORKER-CONTINUED");
  });

  it("a failed fall-through ends nothing; after its recent window one more reroute may run", async () => {
    // the origin keeps fallThroughTo but no rerouted marker (the incident's shape: a reroute whose restart died rolled the marker back, or a rebuild lost it) — the repeat guard is liveFallThrough, and once w2 failed and aged out of its recent window exactly one more attempt runs
    const o = stale();
    delete (o as Partial<WorkerStatus>).rerouted;
    saveStatus(dir, o);
    saveStatus(dir, ft("failed", 1), new Date(Date.now() - AGO), true); // ended 6 min ago: past the recent window
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir)).toEqual([]);
    expect(loadStatus(dir, "w1")!.state).toBe("queued"); // still waiting for its next chance
    const spawned: string[] = [];
    const late = Date.now() + 6 * 60_000; // w2's end (6 min ago) is now past the recent window
    const done = await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, late, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
    expect(spawned).toEqual(["w1"]); // the failed fall-through aged out of its recent window: one more try
    expect(done.map((e) => e.id)).toEqual(["w1"]);
    // and the marker now stands: a third tick never spawns again, recent or not
    await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, late + 6 * 60_000, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
    expect(spawned).toEqual(["w1"]);
  });

  it("a failed fall-through with the marker stands down inside its recent window and blocks nothing else", async () => {
    saveStatus(dir, stale());
    const f = ft("failed", 1);
    saveStatus(dir, f); // `updated` now: inside the recent window
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir)).toEqual([]);
    const spawned: string[] = [];
    await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, Date.now() + 6 * 60_000, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
    expect(spawned).toEqual([]); // the rerouted marker holds it: no second fall-through while w2 is recent
  });

  it("a just-finished clean fall-through waits for its caller's follow path; later ticks never reroute", async () => {
    saveStatus(dir, stale());
    saveStatus(dir, ft("done", 0)); // finished moments ago (saveStatus stamps `updated` now): the follower still owns the hand-off
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir)).toEqual([]);
    const spawned: string[] = [];
    await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, Date.now(), { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
    expect(spawned).toEqual([]); // inside the recent window: no reroute
    // past the window the daemon pass ends it; later ticks do nothing, ever
    const late = Date.now() + 6 * 60_000;
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir, late)).toEqual(["w1"]);
    for (let i = 0; i < 3; i++) {
      await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, late + (i + 1) * 60_000, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
      expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir, late + (i + 1) * 60_000)).toEqual([]);
    }
    expect(spawned).toEqual([]); // never rerouted again
    expect(loadStatus(dir, "w1")!.state).toBe("killed");
  });
});

