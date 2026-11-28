import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escalationMessage, rerunFromEnv, defaultSpawn, endContinuedOrigins, escalationReason, escalationHeldNote, providerPinned, escalateOverdue, rerouteWorker, taskText, fullTaskText, ID_FILE_ENV, RERUN_ID_FILE_ENV, RERUN_OF_ENV, RERUN_OF_FILE_ENV, URGENT_QUEUED_MIN, type ReroutePolicy, type SpawnSpec } from "./reroute.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";
import { getProfile, lastProfileWriteLogError, profilesPath, setProfileLedger, updateProfile, nextClockTime } from "./session-profile-store.js";
import { namesTarget, resolveWorkers } from "./session-profile.js";
import { resolveTarget, type TargetDeps } from "./target.js";
import { sessionProfileSet, type SessionProfileDeps } from "../daemon-mcp/tools/session-profile.js";
import { parseLedger } from "./ledger.js";
import { stopOriginFirst } from "./run/escalate.js";
import { isReadOnlyJob } from "./run/stream.js";
import { carryGoals } from "./note-delivery.js";
import { budgetCheck, budgetProgress, distinctTestRuns, budgetText, emptySnapshot, fireBudget, initialBudgetMinutes, nextBudgetMinutes, parseExtendMinutes, reviewNote, DEFAULT_TIME_BUDGET } from "./time-budget.js";
import { fallThroughReason } from "./policy.js";
import { parseBudget } from "./deadline.js";

let dir: string;
let savedHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reroute-"));
  writeFileSync(join(dir, "spec.txt"), "do the thing", "utf8");
  // the profile tests below get a temp home: their store and ledger never touch the machine's
  savedHome = process.env.PAI_HOME;
  process.env.PAI_HOME = join(dir, "home");
  setProfileLedger(() => join(dir, "ledger.log"));
});
afterEach(() => {
  setProfileLedger(undefined);
  if (savedHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

const queued = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id: "w1", pid: 4321, label: "l", cwd: "/", term: "", provider: "fakeA", model: "m", state: "queued", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, promptFile: "/nonexistent-prompt", ...over }) as WorkerStatus;

// ---------------------------------------------------------------------------
// The session profile's workers pin (2026-11-18: a one-run --cloud / reroute
// showed up as a standing "workers: anthropic" pin). Only an explicit set —
// `pai session profile set --workers` / session_profile_set — writes it; a run
// or a reroute never does, and every write names its caller in the ledger.
// ---------------------------------------------------------------------------

// a config the resolver accepts without reaching the network or the real files
type FakeCfg = Parameters<typeof resolveWorkers>[1]["cfg"] & { tiers?: unknown[] };
const fakeCfg = (over: { active?: string | null } = {}): FakeCfg =>
  ({ providers: {}, nativeModels: { default: "m" }, active: null, routing: { policy: "auto", priority: [], order: [], budgetPriority: [] }, tiers: [], ...over }) as unknown as FakeCfg;
const fakeCtx = () => async () => ({ cfg: fakeCfg(), profile: null, env: {}, budgets: {}, routing: {} as never });

// the store under a name of its own: the updateProfile calls below are the
// test's own setup (they log on purpose); "no write" asserts about Sess only
const otherStore = (): string => {
  const p = join(dir, "other-profiles.yaml");
  setProfileLedger(() => `${p}.ledger.log`);
  return p;
};
const profileLedgerWrites = (store: string): ReturnType<typeof parseLedger> => {
  const f = `${store}.ledger.log`;
  return existsSync(f) ? parseLedger(readFileSync(f, "utf8")).filter((l) => l.event === "PROFILE-WRITE") : [];
};

describe("session profile workers pin writers", () => {
  it("a run with --cloud leaves the profile unchanged and logs no write", async () => {
    const store = otherStore();
    updateProfile("Sess", { workers: { provider: "kimi" } }, store); // an explicit pin, set first (this setup logs)
    const before = getProfile("Sess", store)!;
    const deps: TargetDeps = {
      workers: fakeCfg({ active: "gyro-l" }),
      logDir: dir,
      env: {},
      profileCtx: fakeCtx(),
      check: async () => false,
    };
    const t = await resolveTarget({ where: "cloud" }, deps);
    expect(t.provider).toBe("anthropic"); // cloud resolves with no loopback server up
    expect(getProfile("Sess", store)).toEqual(before);
    expect(profileLedgerWrites(store).filter((l) => l.fields.session === "Sess")).toHaveLength(1); // only the setup's own set
  });

  it("an explicit --cloud with a profile provider set names its target: the profile is not asked", () => {
    const store = otherStore();
    updateProfile("Sess", { workers: { provider: "hy4-flash" } }, store);
    expect(getProfile("Sess", store)!.workers?.provider).toBe("hy4-flash");
    expect(namesTarget({ cloud: true })).toBe(true);
    expect(namesTarget({ localFlag: true })).toBe(true);
    expect(namesTarget({ providerFlag: "x" })).toBe(true);
    expect(namesTarget({ whereFlag: "cloud" })).toBe(true);
    expect(namesTarget({})).toBe(false); // a run without flags still follows the profile
  });

  it("an explicit --cloud, profile set while the run is queued: the decision was made at start and stays cloud", async () => {
    const store = otherStore();
    const opts = { cloud: true };
    const decide = () => (namesTarget(opts) ? "cloud" : (getProfile("Sess", store)?.workers?.provider ?? "global"));
    const atStart = decide(); // no profile provider yet
    updateProfile("Sess", { workers: { provider: "hy4-flash" } }, store); // the profile changes while queued
    expect(atStart).toBe("cloud");
    expect(decide()).toBe("cloud");
  });

  it("reroute --where cloud leaves the profile unchanged and logs no write", async () => {
    const store = otherStore();
    updateProfile("Sess", { workers: { provider: "kimi" } }, store);
    const before = getProfile("Sess", store)!;
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt") }));
    const r = await rerouteWorker("w1", "cloud", {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
      kill: async () => [],
      spawn: (_s: SpawnSpec) => undefined,
    });
    expect(r.provider).toBe("fakeB");
    expect(getProfile("Sess", store)).toEqual(before);
    expect(profileLedgerWrites(store).filter((l) => l.fields.session === "Sess")).toHaveLength(1); // only the setup's own set
  });

  it("an explicit set writes the pin with no implicit mark and names its caller in the ledger", async () => {
    const store = otherStore();
    const deps: SessionProfileDeps = { path: store, env: { PAI_SESSION_NAME: "Sess" }, ctx: fakeCtx() };
    const r = await sessionProfileSet({ name: "Sess", workers: { provider: "kimi" } }, deps);
    expect(r.isError).toBeFalsy();
    const p = getProfile("Sess", store)!;
    expect(p.workers).toEqual({ provider: "kimi" });
    expect(p.workers_implicit).toBeUndefined();
    const line = profileLedgerWrites(store).find((l) => l.fields.session === "Sess");
    if (!line) throw new Error(`no PROFILE-WRITE line, error: ${lastProfileWriteLogError() ?? "none"}`);
    expect(line.fields.caller).toBe("session-profile-set");
  });

  it("an explicit set replaces a launch-written implicit pin and clears the mark", async () => {
    const store = otherStore();
    updateProfile("Sess", { workers: { provider: "anthropic" }, workers_implicit: true }, store, "launch-setup");
    const deps: SessionProfileDeps = { path: store, env: { PAI_SESSION_NAME: "Sess" }, ctx: fakeCtx() };
    await sessionProfileSet({ name: "Sess", workers: { provider: "kimi" } }, deps);
    const p = getProfile("Sess", store)!;
    expect(p.workers).toEqual({ provider: "kimi" });
    expect(p.workers_implicit).toBeUndefined();
  });

  it("a patch that changes nothing writes nothing: no file rewrite, no ledger line", () => {
    const store = otherStore();
    updateProfile("Sess", { workers: { provider: "kimi" } }, store);
    const content = readFileSync(store, "utf8");
    setProfileLedger(() => { throw new Error("must not log a no-op"); });
    const after = updateProfile("Sess", { workers: { provider: "kimi" } }, store);
    expect(after.workers).toEqual({ provider: "kimi" });
    expect(readFileSync(store, "utf8")).toBe(content);
  });
});

const NOW = Date.parse("2026-11-16T12:00:00Z");
const pol = (queuedMaxMin: number): ReroutePolicy => ({ queuedMaxMin, stallCalls: 60, stallFailedCalls: 6 });
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
  it("running stall counts turns, not minutes", () => {
    const r = job({ state: "running", turns: 60, turnsAtProgress: 0 } as never);
    expect(escalationReason(r, NOW, pol(0))).toContain("no edit or commit");
    expect(escalationReason(job({ state: "running", consecFails: 6 } as never), NOW, pol(0))).toContain("failed tool calls");
  });
});

describe("convergence rule (local runs)", () => {
  const stamp = (ms: number): string => nowStamp(new Date(ms));
  const MIN = 60_000;
  const run = (o: Partial<WorkerStatus>): WorkerStatus =>
    job({ state: "running", route: { policy: "auto", reason: "x", local: true }, started: stamp(NOW - 40 * MIN), maxMinutes: 120, turns: 30, turnsAtProgress: 29, progressAt: stamp(NOW - MIN), ...o } as never);
  it("edits without commit past the threshold: escalated with the reason", () => {
    expect(escalationReason(run({}), NOW, pol(0))).toBe("no convergence: 40m without commit or green check");
  });
  it("a recent commit or green check: not escalated", () => {
    expect(escalationReason(run({ convergedAt: stamp(NOW - 5 * MIN) }), NOW, pol(0))).toBeNull();
  });
  it("an old convergence does not shield a quiet run", () => {
    expect(escalationReason(run({ convergedAt: stamp(NOW - 20 * MIN) }), NOW, pol(0))).toBe("no convergence: 20m without commit or green check");
  });
  it("not armed before 25 min or half the budget", () => {
    expect(escalationReason(run({ started: stamp(NOW - 20 * MIN) }), NOW, pol(0))).toBeNull();
    expect(escalationReason(run({ started: stamp(NOW - 20 * MIN), maxMinutes: 30 }), NOW, pol(0))).toBe("no convergence: 20m without commit or green check"); // 50% of 30 = 15
  });
  it("cloud runs are unaffected", () => {
    expect(escalationReason(run({ route: { policy: "auto", reason: "x", local: false } }), NOW, pol(0))).toBeNull();
  });
  it("thresholds are config keys", () => {
    expect(escalationReason(run({}), NOW, { ...pol(0), convergeQuietMin: 60 })).toBeNull();
  });
  it("the escalation counts per model in the ledger", async () => {
    saveStatus(dir, run({ id: "w1", promptFile: join(dir, "spec.txt"), model: "m-x", provider: "fakeA" } as never));
    writeFileSync(join(dir, "spec.txt"), "task");
    const out = await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: () => undefined }, NOW);
    expect(out[0]!.reason).toMatch(/^no convergence:/);
    const lines = readFileSync(join(dir, "ledger.log"), "utf8");
    expect(lines).toContain("WORKER-ESCALATE-NOCONVERGE");
    expect(lines).toContain("m-x");
  });
});

describe("escalationReason", () => {
  it("an overdue queued job moves; a fresh one and an already rerouted one do not", () => {
    const now = Date.now();
    const held = (sinceMs: number): Partial<WorkerStatus> => ({ capacity: { provider: "fakeA", cap: 1, total: 1, position: 1, elapsedSec: 0, sinceMs } });
    expect(escalationReason(queued({ ...held(now - 16 * 60_000), now: true }), now, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 })).toContain("queued 16m");
    expect(escalationReason(queued(held(now - 60_000)), now, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 })).toBeNull();
    expect(escalationReason(queued({ ...held(now - 16 * 60_000), now: true, rerouted: "x" }), now, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 })).toBeNull();
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

  it("a running origin is stopped before the continuation starts and ends rerouted with fallThroughTo", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "running" }));
    const order: string[] = [];
    await rerouteWorker("w1", "cloud", {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "d" }),
      kill: async (id) => {
        order.push("kill");
        const st = loadStatus(dir, id)!;
        st.state = "killed"; st.rc = 143; delete st.rerouted; // the origin's own exit rewrote its status without the marker
        saveStatus(dir, st, new Date(), true);
        return [];
      },
      spawn: (s: SpawnSpec) => {
        order.push("spawn");
        const o = loadStatus(dir, s.id)!;
        o.fallThroughTo = "w2";
        saveStatus(dir, o, new Date(), true);
      },
    });
    expect(order).toEqual(["kill", "spawn"]);
    const st = loadStatus(dir, "w1")!;
    expect(st.rerouted).toBe("fakeB: reroute");
    expect(st.fallThroughTo).toBe("w2");
    expect(st.state).toBe("killed");
  });

  it("a review-stopped origin is continued on the target with its branch and review reason, nothing killed, old run superseded", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "review", needsReview: true, branch: "worker/w1", last: "no progress in its 20-min allowance" }));
    let killed = false;
    let spec: SpawnSpec | undefined;
    const r = await rerouteWorker("w1", "cloud", {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "d" }),
      kill: async () => { killed = true; return []; },
      spawn: (s: SpawnSpec) => {
        spec = s;
        const o = loadStatus(dir, s.id)!;
        o.fallThroughTo = "w2";
        saveStatus(dir, o, new Date(), true);
      },
    });
    expect(killed).toBe(false);
    expect(r.was).toBe("review");
    const note = readFileSync(spec!.specFile, "utf8");
    expect(note).toContain("continued from w1 on branch worker/w1");
    expect(note).toContain("stopped for review: no progress in its 20-min allowance");
    const st = loadStatus(dir, "w1")!;
    expect(st.rerouted).toBe("fakeB: reroute");
    expect(st.continuedBy).toBe("w2");
    expect(st.needsReview).toBeUndefined();
    expect(st.state).toBe("review");
  });

  it("a running origin that cannot be stopped gets no continuation", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "running" }));
    let spawned = false;
    await expect(
      rerouteWorker("w1", "cloud", {
        logDir: dir,
        resolve: async () => ({ provider: "fakeB", description: "d" }),
        kill: async () => { throw new Error("still running"); },
        spawn: () => { spawned = true; },
      })
    ).rejects.toThrow(/still running/);
    expect(spawned).toBe(false);
    expect(loadStatus(dir, "w1")!.rerouted).toBeUndefined();
  });

  it("a priority change on a running worker never starts a fall-through", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    for (const o of [{ now: true }, { now: false, queuePriority: "high" }, { queuePriority: "high", now: true }]) {
      expect(escalationReason(job({ state: "running", progressAt: fresh, ...o } as never), NOW, pol(0))).toBeNull();
    }
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

  // #21: a continuation that dies before announcing is retried once; its stderr is kept and quoted.
  const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid ?? 999999;
  it("defaultSpawn retries a failed first start once and records its stderr", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "running" }));
    let n = 0;
    const fakeStart = ((bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }) => {
      n++;
      if (n === 1) {
        writeFileSync(o.outPath, "boom: exited 1\n");
        return deadPid();
      }
      writeFileSync(o.env[RERUN_ID_FILE_ENV]!, "w2");
      return process.pid;
    }) as typeof import("./reroute.js").spawnSession;
    await defaultSpawn(dir, fakeStart, { retryMs: 10 })({ id: "w1", why: "x", provider: "fakeB", specFile: join(dir, "spec.txt") });
    expect(n).toBe(2);
    expect(readFileSync(join(dir, "runs", "reroute-w1.out"), "utf8")).toContain("boom: exited 1");
  });
  it("defaultSpawn with both starts failing quotes the stderr in the error", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "running" }));
    let n = 0;
    const fakeStart = ((bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }) => {
      n++;
      writeFileSync(o.outPath, `stderr line ${n}\n`);
      return deadPid();
    }) as typeof import("./reroute.js").spawnSession;
    await expect(defaultSpawn(dir, fakeStart, { retryMs: 10 })({ id: "w1", why: "x", provider: "fakeB", specFile: join(dir, "spec.txt") })).rejects.toThrow(/stderr line 1.*stderr line 2/);
    expect(n).toBe(2);
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
    }, now, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 });
    expect(done.map((e) => e.id)).toEqual(["w1"]);
    expect(loadStatus(dir, "w1")!.rerouted).toBe("fakeB: queued 16m (operator priority)"); // the marker names where and why it moved
    expect(loadStatus(dir, "w2")!.rerouted).toBeUndefined();
  });
});

describe("an escalated child worker (2026-11-22)", () => {
  const child = (over: Partial<WorkerStatus> = {}) => queued({ promptFile: join(dir, "spec.txt"), state: "running", parent: "p1", cwd: dir, ...over });
  const pol0 = { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 };

  it("a restart queued at the target's cap announces its id; the reroute records the continuation, parent link kept", async () => {
    saveStatus(dir, child());
    const order: string[] = [];
    const fakeStart = ((_bin: string, _args: string[], o: { env: NodeJS.ProcessEnv }) => {
      // the full cap: the run is only queued, and still announces (gateStart) with the status saved as queued
      saveStatus(dir, queued({ id: "w2", state: "queued", parent: "p1", capacity: { provider: "fakeB", cap: 1, total: 3, position: 2, elapsedSec: 0, sinceMs: Date.now() } }));
      const run = { providerFlag: "fakeB" } as never;
      rerunFromEnv(run, dir, { ...o.env });
      (run as { onWorkerStart: (id: string) => void }).onWorkerStart("w2");
      writeFileSync(o.env[RERUN_ID_FILE_ENV]!, "w2");
      return process.pid;
    }) as typeof import("./reroute.js").spawnSession;
    const r = await rerouteWorker("w1", "cloud", {
      logDir: dir,
      announceMs: 0,
      resolve: async () => ({ provider: "fakeB", description: "d" }),
      kill: async (id) => { order.push("kill"); const st = loadStatus(dir, id)!; st.state = "killed"; saveStatus(dir, st, new Date(), true); return []; },
      spawn: (s: SpawnSpec) => { order.push("spawn"); return defaultSpawn(dir, fakeStart)(s); },
    });
    expect(order).toEqual(["kill", "spawn"]); // stop-first kept: the salvage lands before the continuation reads the branch
    expect(r.queuedAtTarget).toEqual({ position: 2, queued: 3 });
    expect(loadStatus(dir, "w1")!.fallThroughTo).toBe("w2");
    const { launchParent } = await import("./tree.js");
    expect(launchParent(undefined, { [RERUN_OF_ENV]: "w1" }, dir)).toBe("p1");
  });

  it("the gate announces a restart at the queue (no PAI_RERUN_ID_FILE exception)", () => {
    expect(readFileSync(join(__dirname, "run", "gate.ts"), "utf8")).not.toContain("RERUN_ID_FILE_ENV");
  });

  it("a start failure after the stop raises the orphan report naming the branch", async () => {
    saveStatus(dir, child({ branch: "worker/w1", progressAt: new Date(NOW - 30 * 60_000).toISOString(), turns: 70, turnsAtProgress: 0 } as never));
    const done = await escalateOverdue([loadStatus(dir, "w1")!], {
      logDir: dir,
      announceMs: 0,
      resolve: async () => ({ provider: "fakeB", description: "d" }),
      kill: async (id) => { const st = loadStatus(dir, id)!; st.state = "killed"; saveStatus(dir, st, new Date(), true); return []; },
      spawn: () => { throw new Error("the restart on fakeB did not start"); },
    }, NOW, pol0);
    expect(done).toHaveLength(1);
    expect(done[0]!.orphaned).toEqual({ branch: "worker/w1" });
    expect(escalationMessage(done[0]!)).toMatch(/ORPHANED.*branch worker\/w1/);
  });
});

describe("one live fall-through per origin", () => {
  const run = async (stale: WorkerStatus[], spawned: string[]) =>
    escalateOverdue(stale, { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, Date.now(), { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 });
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
    const done = await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, late, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 });
    expect(spawned).toEqual(["w1"]); // the failed fall-through aged out of its recent window: one more try
    expect(done.map((e) => e.id)).toEqual(["w1"]);
    // and the marker now stands: a third tick never spawns again, recent or not
    await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, late + 6 * 60_000, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 });
    expect(spawned).toEqual(["w1"]);
  });

  it("a failed fall-through with the marker stands down inside its recent window and blocks nothing else", async () => {
    saveStatus(dir, stale());
    const f = ft("failed", 1);
    saveStatus(dir, f); // `updated` now: inside the recent window
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir)).toEqual([]);
    const spawned: string[] = [];
    await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, Date.now() + 6 * 60_000, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 });
    expect(spawned).toEqual([]); // the rerouted marker holds it: no second fall-through while w2 is recent
  });

  it("a just-finished clean fall-through waits for its caller's follow path; later ticks never reroute", async () => {
    saveStatus(dir, stale());
    saveStatus(dir, ft("done", 0)); // finished moments ago (saveStatus stamps `updated` now): the follower still owns the hand-off
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir)).toEqual([]);
    const spawned: string[] = [];
    await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, Date.now(), { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 });
    expect(spawned).toEqual([]); // inside the recent window: no reroute
    // past the window the daemon pass ends it; later ticks do nothing, ever
    const late = Date.now() + 6 * 60_000;
    expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir, late)).toEqual(["w1"]);
    for (let i = 0; i < 3; i++) {
      await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, late + (i + 1) * 60_000, { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 });
      expect(endContinuedOrigins([loadStatus(dir, "w1")!], dir, late + (i + 1) * 60_000)).toEqual([]);
    }
    expect(spawned).toEqual([]); // never rerouted again
    expect(loadStatus(dir, "w1")!.state).toBe("killed");
  });
});


describe("the task copy of a -p run", () => {
  it("taskText falls back to <id>.prompt when the status names no file", () => {
    writeFileSync(join(dir, "w9.prompt"), "the task", "utf8");
    expect(taskText(dir, queued({ id: "w9", promptFile: undefined }))).toBe("the task");
  });
  it("a later full status write for the same id keeps promptFile", () => {
    saveStatus(dir, queued({ id: "w8", promptFile: join(dir, "w8.prompt") }));
    saveStatus(dir, queued({ id: "w8", promptFile: undefined, state: "running" }));
    expect(loadStatus(dir, "w8")!.promptFile).toBe(join(dir, "w8.prompt"));
  });
});

describe("a rerouted run's end reaches its owning session", () => {
  const ended = (over: Partial<WorkerStatus>): WorkerStatus =>
    ({ id: "r2", pid: 999999, label: "l", cwd: "/", term: "", provider: "anthropic", model: "m", state: "done", started: "2026-11-17 08:00:00", updated: "2026-11-17 09:00:00", turns: 3, tools: 1, last: "", rc: 0, secs: 5, outputFormat: "json", spawnerSession: "owner-sess", ...over }) as WorkerStatus;

  it("pushes the restart's notice once for a json-format restart, not for a plain json run", async () => {
    const { runSupervisionTick } = await import("./supervision.js");
    const pushed: string[] = [];
    // failed (rc=1): urgent, so it pushes — the plain run's rc=0 finish is now
    // routine and goes to the digest instead of a push (notice-triage.ts)
    const push = async (_l: string, _t: unknown, ev: { worker: string }): Promise<boolean> => {
      pushed.push(ev.worker);
      return true;
    };
    const statuses = [ended({ id: "r2", fallThroughOf: "r1", state: "failed", rc: 1 }), ended({ id: "plain" })];
    const opts = { statuses, push: push as never, reroute: false, now: new Date("2026-11-17T09:05:00"), isAlive: () => false };
    await runSupervisionTick(dir, { ...opts, statuses: [] }); // the first tick only baselines
    await runSupervisionTick(dir, opts);
    await runSupervisionTick(dir, opts);
    expect(pushed).toEqual(["r2"]);
  });
});

describe("operator goals travel to continuations", () => {
  const H = "Operator goals given to the previous run (apply them, in order):";
  const goals = (id: string, texts: string[], extra: Partial<WorkerStatus> = {}, pending: string[] = []): void => {
    saveStatus(dir, queued({ id, state: "done", goals: texts.map((text, i) => ({ text, at: `12:0${i}` })), note: texts[texts.length - 1], notePending: pending, ...extra }));
  };
  const promptOf = (args: string[]): string => args[args.length - 1] ?? "";

  it("an escalated continuation (_priorIds) gets every goal in order, pending ones included, once", () => {
    goals("A", ["one", "two", "three"], {}, ["three"]);
    const args = carryGoals(dir, ["-p", "the task"], ["A"]);
    expect(promptOf(args)).toBe(`the task\n\n${H}\n1. [12:00] one\n2. [12:01] two\n3. [12:02] three`);
    expect(loadStatus(dir, "A")?.notePending).toEqual([]); // not delivered a second time
  });
  it("a rerouted continuation (rerunFromEnv) gets the origin's goals", async () => {
    const { rerunFromEnv } = await import("./reroute.js");
    goals("w1", ["use the cache"]);
    const run = { claudeArgs: ["-p", "task"] } as never as import("./run/types.js").RunOptions;
    rerunFromEnv(run, dir, { [RERUN_OF_ENV]: "w1" });
    expect(run._priorIds).toEqual(["w1"]);
    expect(promptOf(carryGoals(dir, run.claudeArgs, run._priorIds))).toContain(`${H}\n1. [12:00] use the cache`);
  });
  it("a fall-through continuation gets the goals of the run it repeats", () => {
    goals("L", ["only cloud-safe code"]);
    expect(promptOf(carryGoals(dir, ["-p", "task"], ["L"]))).toContain("only cloud-safe code");
  });
  it("a two-step chain keeps both runs' goals (and no duplicated section)", () => {
    goals("A", ["a1"]);
    goals("B", ["b1", "b2"], { fallThroughOf: "A" });
    const forC = carryGoals(dir, ["-p", "task"], ["B"]);
    expect(promptOf(forC)).toBe(`task\n\n${H}\n1. [12:00] a1\n2. [12:00] b1\n3. [12:01] b2`);
    goals("C", ["c1"], { fallThroughOf: "B" });
    const forD = promptOf(carryGoals(dir, ["-p", promptOf(forC)], ["C"]));
    expect(forD.split(H).length).toBe(2);
    expect(forD).toContain("c1");
    expect(forD).toContain("a1");
  });
  it("no goals: the prompt is untouched", () => {
    saveStatus(dir, queued({ id: "N", state: "done" }));
    expect(carryGoals(dir, ["-p", "task"], ["N"])).toEqual(["-p", "task"]);
  });
});

describe("no continuation while its origin lives", () => {
  const live = (): WorkerStatus => queued({ promptFile: join(dir, "spec.txt"), state: "running", pid: process.ppid });
  it("an origin that cannot be stopped blocks the in-process continuation; one that stops lets it start", async () => {
    saveStatus(dir, live());
    expect(await stopOriginFirst(dir, "w1", async () => { throw new Error("no"); })).toBe(false);
    expect(await stopOriginFirst(dir, "w1", async () => []), "kill returned but status still live").toBe(false);
    expect(await stopOriginFirst(dir, "w1", async (id) => { const st = loadStatus(dir, id)!; st.state = "killed"; saveStatus(dir, st, new Date(), true); return []; })).toBe(true);
  });
  it("a clean continuation, however old, and a continued origin are never escalated again", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "running" }));
    saveStatus(dir, queued({ id: "w2", fallThroughOf: "w1", state: "done", rc: 0, updated: "2026-01-01 00:00:00" }));
    const { liveFallThrough } = await import("./reroute.js");
    expect(liveFallThrough(dir, "w1", Date.now() + 3600_000)).toBe("w2");
    expect(escalationReason(job({ state: "running", continuedBy: "w2", progressAt: new Date(NOW - 30 * 60_000).toISOString() } as never), NOW, pol(0))).toBeNull();
  });
});

describe("escalationReason counts turns since progress, never minutes", () => {
  const run = (o: object) => job({ state: "running", started: new Date(NOW - 600 * 60_000).toISOString(), progressAt: new Date(NOW - 500 * 60_000).toISOString(), ...o } as never);
  it("hours of wall time but few turns: a slow machine is not stalled", () => {
    expect(escalationReason(run({ turns: 20, turnsAtProgress: 0 }), NOW, pol(0))).toBeNull();
  });
  it("stallCalls turns since the last progress: escalated, worded by deliverable", () => {
    expect(escalationReason(run({ turns: 70, turnsAtProgress: 10 }), NOW, pol(0))).toBe("no edit or commit for 60 turns");
    expect(escalationReason(run({ turns: 70, turnsAtProgress: 10, deliverable: "findings" }), NOW, pol(0))).toBe("no write or report output for 60 turns");
    expect(escalationReason(run({ turns: 70, turnsAtProgress: 10, readOnly: true }), NOW, pol(0))).toBe("no successful tool call for 60 turns");
  });
  it("progress resets the count", () => {
    expect(escalationReason(run({ turns: 70, turnsAtProgress: 65 }), NOW, pol(0))).toBeNull();
  });
  it("time in line at the model changes nothing", () => {
    const sched = { at: NOW, engines: {}, workers: { w1: { waitMsTotal: 9 * 60_000, waitingSince: 0 } } } as never;
    expect(escalationReason(run({ turns: 20, turnsAtProgress: 0 }), NOW, pol(0), sched)).toBeNull();
    expect(escalationReason(run({ turns: 70, turnsAtProgress: 0 }), NOW, pol(0), sched)).toBe("no edit or commit for 70 turns");
  });
});

// 2026-11-18: a code-fix spec whose text contained "(read-only)" describing a dry-run
// command was read as a read-only job (the old rule matched spec wording) and escalated
// on "no successful tool call" instead of the edit rule. The tool set is the only signal.
describe("isReadOnlyJob: the tool set, never the spec text", () => {
  const tools = (...entries: string[]) => entries.map((e) => `${e}(.*)`); // the CLI's own grant spelling
  it("a spec saying read-only with Edit allowed is an editing job", () => {
    expect(isReadOnlyJob(tools("Read", "Edit", "Write", "Bash", "Grep", "Glob"))).toBe(false);
  });
  it("no editing tool granted is read-only, whatever the spec says", () => {
    expect(isReadOnlyJob(tools("Read", "Bash", "Grep", "Glob"))).toBe(true);
  });
  it("an empty tool set is not read-only (the run's default grants cover edits)", () => {
    expect(isReadOnlyJob([])).toBe(false);
  });
});

describe("escalation switch: per session, per run, pinned local", () => {
  const stalled = (o: object = {}) => job({ state: "running", started: new Date(NOW - 60 * 60_000).toISOString(), turns: 70, turnsAtProgress: 0, ...o } as never);
  it("session escalate off: no escalation for that session, still for others", () => {
    updateProfile("Quiet", { escalate: "off" });
    expect(escalationReason(stalled({ sessionKey: "Quiet" }), NOW, pol(0))).toBeNull();
    expect(escalationReason(stalled({ sessionKey: "Loud" }), NOW, pol(0))).toContain("no edit or commit");
    expect(escalationHeldNote(stalled({ sessionKey: "Quiet" }), NOW, pol(0))).toBe("stalled no edit or commit for 70 turns, escalation off for this session");
    expect(escalationHeldNote(stalled({ sessionKey: "Loud" }), NOW, pol(0))).toBeNull();
    updateProfile("Quiet", { escalate: null });
    expect(escalationReason(stalled({ sessionKey: "Quiet" }), NOW, pol(0))).toContain("no edit or commit");
  });
  it("--until expires by itself", () => {
    updateProfile("Quiet", { escalate: "off", escalate_until: NOW + 60_000 });
    expect(escalationReason(stalled({ sessionKey: "Quiet" }), NOW, pol(0))).toBeNull();
    expect(escalationReason(stalled({ sessionKey: "Quiet" }), NOW + 120_000, pol(0))).toContain("no edit or commit");
    expect(nextClockTime("07:00", new Date(2026, 10, 18, 19, 0))).toBe(new Date(2026, 10, 19, 7, 0).getTime());
    expect(nextClockTime("21:30", new Date(2026, 10, 18, 19, 0))).toBe(new Date(2026, 10, 18, 21, 30).getTime());
  });
  it("set through session_profile_set (escalate off + until) and show lists it", async () => {
    const deps: SessionProfileDeps = { path: profilesPath(), env: {}, ctx: fakeCtx() };
    const r = await sessionProfileSet({ name: "Quiet", escalate: "off", until: "07:00" }, deps);
    expect(r.content[0].text).toContain("escalate: off until");
    expect(getProfile("Quiet")?.escalate).toBe("off");
    const on = await sessionProfileSet({ name: "Quiet", escalate: "on" }, deps);
    expect(on.content[0].text).toContain("escalate: on");
    expect(getProfile("Quiet")?.escalate).toBeUndefined();
  });
  it("--no-escalate run is never escalated", () => {
    expect(escalationReason(stalled({ noEscalate: true }), NOW, pol(0))).toBeNull();
    expect(escalationReason(stalled({ noEscalate: true, consecFails: 9 }), NOW, pol(0))).toBeNull();
  });
  it("--where local / --force-local routeWhy count as pinned", () => {
    for (const why of ["gyro-l/m (--where local)", "gyro-l/m (--force-local)", "gyro-l/m (local)", "gyro-l/m (flag: --provider)"]) {
      expect(providerPinned({ routeWhy: why })).toBe(true);
      expect(escalationReason(stalled({ routeWhy: why }), NOW, pol(0))).toBeNull();
    }
    expect(providerPinned({ routeWhy: "gyro-l/m (class: implement)" })).toBe(false);
  });
});

describe("progress-based time budget", () => {
  const cfg = DEFAULT_TIME_BUDGET;
  const snap = (o: Partial<ReturnType<typeof emptySnapshot>>) => ({ ...emptySnapshot(), ...o });

  it("progress doubles the allowance and does not stop", () => {
    const d = budgetCheck(snap({}), snap({ commits: 3, testsPassed: 1 }), { minutes: 20, cfg });
    expect(d).toEqual({ action: "extend", minutes: 40, why: "extended to 40 min: 3 commits, tests ran" });
    expect(nextBudgetMinutes(40, cfg)).toBe(80);
  });

  it("no progress stops for review", () => {
    expect(budgetCheck(snap({ commits: 2 }), snap({ commits: 2 }), { minutes: 20, cfg }).action).toBe("review");
  });

  it("fullTaskText joins the root spec and later resume notes", () => {
    const d = mkdtempSync(join(tmpdir(), "fulltask-"));
    writeFileSync(join(d, "a.prompt"), "ORIGINAL SPEC");
    writeFileSync(join(d, "b.prompt"), "just a note");
    saveStatus(d, { id: "a", promptFile: join(d, "a.prompt") } as never);
    const b = { id: "b", resumedFrom: "a", promptFile: join(d, "b.prompt") } as never;
    saveStatus(d, b);
    expect(fullTaskText(d, b)).toBe("ORIGINAL SPEC\n\n--- note from b ---\njust a note");
  });

  it("an in-flight tool call extends; high load stretches the window; idleness at low load still reviews", () => {
    const f = budgetCheck(snap({}), snap({ inFlight: "Bash: tools/build.sh x --wait" }), { minutes: 20, cfg, load: 1, cores: 8 });
    expect(f).toEqual({ action: "extend", minutes: 40, why: "extended to 40 min: tool call running: Bash: tools/build.sh x --wait" });
    const hot = budgetCheck(snap({}), snap({}), { minutes: 20, cfg, load: 100, cores: 10 });
    expect(hot.action).toBe("extend");
    expect(budgetCheck(snap({}), snap({}), { minutes: 20, cfg, load: 2, cores: 8, turns: 10, tools: 7 })).toEqual({ action: "review", why: "no progress in its 20-min allowance (10 turns, 7 tool calls, load 2.0)" });
  });

  it("host-load deferral is finite: at the ceiling a loaded host still gets a review", () => {
    const ceiling = cfg.cap;
    expect(budgetCheck(snap({}), snap({}), { minutes: ceiling, cfg, load: 100, cores: 10, maxMinutes: ceiling }).action).toBe("review");
    const d = budgetCheck(snap({}), snap({}), { minutes: 20, cfg, load: 100, cores: 10 });
    expect(d.action === "extend" && d.minutes).toBeGreaterThan(20);
  });

  it("an owned running build/test job at the checkpoint extends instead of stopping", () => {
    const d = budgetCheck(snap({ commits: 2 }), snap({ commits: 2, jobActive: true }), { minutes: 20, cfg });
    expect(d).toEqual({ action: "extend", minutes: 40, why: "extended to 40 min: build/test job running" });
    const atCap = budgetCheck(snap({}), snap({ jobActive: true }), { minutes: 20, cfg, maxMinutes: 20 });
    expect(atCap.action).toBe("extend");
    expect(budgetCheck(snap({}), snap({ jobActive: false }), { minutes: 20, cfg }).action).toBe("review");
  });

  it("read-only jobs progress on successful tool calls only", () => {
    expect(budgetProgress(snap({}), snap({ toolsOk: 4 }))).toBeNull();
    expect(budgetProgress(snap({}), snap({ toolsOk: 4 }), true)).toContain("4 successful tool calls");
  });

  it("an identical re-run of the same test counts as progress only once", () => {
    const isTest = (c: string) => /vitest/.test(c);
    const r = (command: string, output: string, failed = false) => ({ command, output, failed });
    expect(distinctTestRuns([r("npx vitest run a", "ok 3"), r("npx vitest run a", "ok 3"), r("npx vitest run a", "ok 3")], isTest)).toBe(1);
    expect(distinctTestRuns([r("npx vitest run a", "ok 3"), r("npx vitest run a", "ok 4"), r("npx vitest run b", "ok 4"), r("npx vitest run c", "x", true), r("ls", "x")], isTest)).toBe(3);
  });

  it("respects the cap and the run's own max-minutes", () => {
    expect(nextBudgetMinutes(80, cfg)).toBe(120);
    expect(nextBudgetMinutes(120, cfg)).toBeNull();
    expect(nextBudgetMinutes(40, cfg, 50)).toBe(50);
    expect(initialBudgetMinutes(cfg, 15)).toBe(15);
    expect(budgetCheck(snap({}), snap({ commits: 1 }), { minutes: 120, cfg }).action).toBe("review");
  });

  it("a review stop is flagged and never falls through to the cloud", () => {
    const st = { id: "w1", state: "running" } as WorkerStatus;
    fireBudget(st, join(dir, "ledger.log"), { action: "review", minutes: 20, why: "no progress in its 20-min allowance" });
    expect(st.needsReview).toBe(true);
    fireBudget(st, join(dir, "ledger.log"), { action: "extend", minutes: 40, why: "x" });
    expect(budgetText(st)).toBe("budget 40m (extended 1x)");
    const route = { local: true, policy: "local-first" } as never;
    const ended = { needsReview: true, timedOut: true, endReason: "timeout", state: "failed" } as never;
    expect(fallThroughReason(route, ended, null, "task", true)).toBeNull();
  });

  it("mailbox line names the ways on; extend and --budget parse durations", () => {
    const n = reviewNote("w1", "task", "no progress", ["abc fix"], "boom");
    expect(n).toContain("pai worker extend w1 30m");
    expect(n).toContain("Last error: boom");
    expect(parseExtendMinutes("30m")).toBe(30);
    expect(parseExtendMinutes("1h")).toBe(60);
    expect(parseExtendMinutes("zzz")).toBeNull();
    expect(parseBudget("20m")).toBe(20);
  });
});

describe("speed-scaled backstop (speed-scale.ts + deadline.ts)", () => {
  // 100 tok/s reference rows, then a slowed window
  const row = (tsMs: number, tps: number, provider = "loc"): never => ({ ts: new Date(tsMs).toISOString(), provider, model: "m", status: 200, output_tokens: 1000, decodeMs: (1000 / tps) * 1000 }) as never;
  const NOW2 = Date.parse("2026-11-23T15:00:00Z");
  const fast = row(NOW2 - 5 * 3600_000, 100);
  const opts = { nowMs: NOW2, isLocal: (p: string) => p === "loc" };
  it("slowdown 2x: factor 2 and it doubles the backstop", async () => {
    const { speedFactor } = await import("./speed-scale.js");
    const { stretchDeadline } = await import("./deadline.js");
    const f = speedFactor("loc", "m", { ...opts, rows: [fast, row(NOW2 - 60_000, 50)] });
    expect(f).toBeCloseTo(2, 1);
    // 10 min of wall time at factor 2 pushes a 60 min limit by 5 min (counts as 5 own minutes)
    const lim = { deadlineAt: NOW2 + 60 * 60_000, minutes: 60 };
    expect(stretchDeadline(lim, true, f, 10 * 60_000, NOW2).deadlineAt - lim.deadlineAt).toBeCloseTo(5 * 60_000, -2);
    // a full-limit stretch: elapsed == whole limit doubles it
    expect(stretchDeadline(lim, true, 2, 60 * 60_000, NOW2).deadlineAt - lim.deadlineAt).toBe(30 * 60_000);
  });
  it("clamped at maxScale 4 (and at the default)", async () => {
    const { speedFactor, clampScale } = await import("./speed-scale.js");
    expect(speedFactor("loc", "m", { ...opts, rows: [fast, row(NOW2 - 60_000, 5)] })).toBe(4);
    expect(speedFactor("loc", "m", { ...opts, maxScale: 3, rows: [fast, row(NOW2 - 60_000, 5)] })).toBe(3);
    expect(clampScale(0.5)).toBe(1);
    expect(clampScale(NaN)).toBe(1);
  });
  it("cloud provider unchanged", async () => {
    const { speedFactor } = await import("./speed-scale.js");
    expect(speedFactor("cloud", "m", { ...opts, rows: [row(NOW2 - 5 * 3600_000, 100, "cloud"), row(NOW2 - 60_000, 10, "cloud")] })).toBe(1);
  });
  it("missing measurement = factor 1", async () => {
    const { speedFactor } = await import("./speed-scale.js");
    expect(speedFactor("loc", "m", { ...opts, rows: [] })).toBe(1);
    expect(speedFactor("loc", "m", { ...opts, rows: [fast] })).toBe(1); // nothing in the recent window
  });
  it("escalation is speed-independent: the same turns decide at any factor", () => {
    const s = { state: "running", turns: 70, turnsAtProgress: 10 } as never;
    expect(escalationReason(job(s), NOW, pol(0))).toBe("no edit or commit for 60 turns");
  });
});

describe("supervision does not block the event loop (#21)", () => {
  it("a request arriving during 5 s of sync per-worker work is served within 100 ms", async () => {
    const { runSupervisionTick } = await import("./supervision.js");
    const mk = (id: string): WorkerStatus =>
      ({ id, pid: process.pid, label: "l", cwd: "/", term: "", provider: "local", model: "m", state: "running", started: "2026-11-23 12:00:00", updated: "2026-11-23 12:00:01", turns: 1, tools: 0, last: "", rc: null, secs: 1, spawnerSession: "owner" }) as unknown as WorkerStatus;
    const statuses = Array.from({ length: 100 }, (_, i) => mk(`w${i}`));
    const busy = (ms: number): void => { const t = Date.now(); while (Date.now() - t < ms); };
    // Deterministic: count event-loop turns served (setImmediate chain) instead of
    // measuring wall-clock gaps. Between two per-worker sync chunks the tick must hand
    // the loop back, so the counter advances between (nearly) every pair of reads.
    let turns = 0;
    let running = true;
    const spin = (): void => { turns++; if (running) setImmediate(spin); };
    setImmediate(spin);
    let reads = 0;
    let served = 0;
    let lastTurns = -1;
    const tick = runSupervisionTick(dir, {
      statuses, reroute: false, push: (async () => true) as never, isAlive: () => true,
      loops: { readEvents: (() => { if (turns !== lastTurns) served++; lastTurns = turns; reads++; busy(5); return []; }) as never },
    });
    await tick;
    running = false;
    expect(reads).toBeGreaterThanOrEqual(100);
    // a blocked loop serves ~1 turn for the whole tick; a yielding one serves most gaps
    expect(served).toBeGreaterThanOrEqual(reads * 0.8);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// lineage: A rerouted to B, B escalated to C — waits, notices and pending follow the final continuation
describe("reroute lineage", () => {
  const sh = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const mk = (id: string, over: Partial<WorkerStatus>): WorkerStatus =>
    ({ id, pid: 0, label: "fix", cwd: "/", term: "", provider: "p", model: "m", state: "done", started: nowStamp(), updated: nowStamp(), turns: 1, tools: 0, last: "", rc: 0, secs: 1, spawnerSession: "L0", ...over }) as WorkerStatus;

  it("wait on A reports C's end under finalId; the mailbox notice names C and A", async () => {
    saveStatus(dir, mk("A", { state: "killed", rc: 143, rerouted: "cloud: stalled", fallThroughTo: "B" }));
    saveStatus(dir, mk("B", { state: "killed", rc: 143, rerouted: "cloud: stalled", fallThroughOf: "A", fallThroughTo: "C" }));
    saveStatus(dir, mk("C", { fallThroughOf: "B" }));
    const { waitWorkers } = await import("./wait.js");
    const { results } = await waitWorkers(dir, ["A"], { timeoutMs: 5_000, intervalMs: 20 });
    expect(results[0]).toMatchObject({ id: "A", finalId: "C", followed: ["B", "C"], state: "done", ok: true });
    const { detectSupervisionEvents } = await import("./supervision.js");
    const ev = (await detectSupervisionEvents([loadStatus(dir, "A")!, loadStatus(dir, "B")!, loadStatus(dir, "C")!], { now: new Date(), stallMs: 600_000 })).find((e) => e.worker === "C");
    expect(ev?.text).toMatch(/^continuation C of A \(fix\) finished: rc=0; merge with pai worker merge C/);
  });

  it("after merging C, pending shows neither A nor B; gc discards them only when their commits are on main", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "t@t");
    sh(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "f"), "0");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
    const logDir = join(dir, "logs");
    const tree = (id: string): { dir: string; branch: string } => {
      const d = join(logDir, "worktrees", id);
      mkdirSync(join(logDir, "worktrees"), { recursive: true });
      sh(repo, "worktree", "add", "-q", "-b", `pai/${id}`, d);
      writeFileSync(join(d, `${id}.txt`), id);
      sh(d, "add", "."); sh(d, "commit", "-qm", `work ${id}`);
      return { dir: d, branch: `pai/${id}` };
    };
    const ta = tree("A"), tb = tree("B"), tc = tree("C");
    const base = (id: string, t: { dir: string; branch: string }, over: Partial<WorkerStatus>): WorkerStatus =>
      mk(id, { cwd: repo, worktreeDir: t.dir, branch: t.branch, ...over });
    saveStatus(logDir, base("A", ta, { state: "killed", rc: 143, rerouted: "x", fallThroughTo: "B" }));
    saveStatus(logDir, base("B", tb, { state: "killed", rc: 143, rerouted: "x", fallThroughOf: "A", fallThroughTo: "C" }));
    saveStatus(logDir, base("C", tc, { fallThroughOf: "B" }));
    const { pendingResults } = await import("./pending.js");
    const { markSuperseded } = await import("./lineage.js");
    const { gcWorktrees } = await import("./worktree.js");
    expect(pendingResults(logDir, repo).map((r) => r.id).sort()).toEqual(["A", "B", "C"]);
    // C merged: its work (and, same branch lineage, B's) lands on main; A's commits stay off main
    sh(repo, "merge", "-q", "--no-ff", "-m", "merge C", tc.branch);
    sh(repo, "merge", "-q", "--no-ff", "-m", "merge B", tb.branch);
    saveStatus(logDir, { ...loadStatus(logDir, "C")!, merged: true, branch: null, worktreeDir: null } as WorkerStatus);
    expect(markSuperseded(logDir, loadStatus(logDir, "C")!)).toEqual(["B", "A"]);
    expect(loadStatus(logDir, "A")!.supersededBy).toBe("C");
    expect(pendingResults(logDir, repo)).toEqual([]);
    const res = gcWorktrees(logDir, 24 * 365, false, Date.now(), true);
    expect(res.find((r) => r.id === "B")?.archive).toBeTruthy();
    expect(res.find((r) => r.id === "A")?.archive).toBeUndefined();
    expect(res.find((r) => r.id === "A")?.skipped).toMatch(/not on main/);
    expect(existsSync(ta.dir)).toBe(true);
    expect(existsSync(tb.dir)).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// harness runs (the merge gate's smoke start) stay out of L0 notices, the digest and pending
describe("harness runs stay out of L0 notices", () => {
  const sh = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const mk = (id: string, over: Partial<WorkerStatus>): WorkerStatus =>
    ({ id, pid: 0, label: "fix", cwd: "/", term: "", provider: "p", model: "m", state: "done", started: nowStamp(), updated: nowStamp(), turns: 1, tools: 0, last: "", rc: 0, secs: 1, spawnerSession: "L0", ...over }) as WorkerStatus;

  it("a smoke start finishing (also as a fall-through of a rerouted origin) emits no notice; a normal continuation still notifies", async () => {
    // the merge gate's smoke start: harness origin, no session, no worktree
    saveStatus(dir, mk("SMOKE", { origin: "harness", label: "merge gate smoke start", spawnerSession: undefined, session: undefined }));
    // its fall-through path: a rerouted origin whose continuation is the smoke run
    saveStatus(dir, mk("ORIG", { state: "killed", rc: 143, rerouted: "cloud: stalled", fallThroughTo: "SMOKE" }));
    saveStatus(dir, mk("SMOKE2", { origin: "harness", label: "merge gate smoke start", spawnerSession: undefined, session: undefined, fallThroughOf: "ORIG" }));
    // a normal rerouted continuation of a session's worker: still notifies
    saveStatus(dir, mk("NORM", { fallThroughOf: "ORIG" }));
    const { detectSupervisionEvents } = await import("./supervision.js");
    const all = [loadStatus(dir, "SMOKE")!, loadStatus(dir, "ORIG")!, loadStatus(dir, "SMOKE2")!, loadStatus(dir, "NORM")!];
    const ev = await detectSupervisionEvents(all, { now: new Date(), stallMs: 600_000 });
    expect(ev.find((e) => e.worker === "SMOKE")).toBeUndefined();
    expect(ev.find((e) => e.worker === "SMOKE2")).toBeUndefined();
    // ORIG's continuation is the harness run: its failure names no merge target (the smoke is not mergeable work)
    expect(ev.find((e) => e.worker === "ORIG")?.text).toMatch(/^worker ORIG fix failed rc=143/);
    const norm = ev.find((e) => e.worker === "NORM");
    expect(norm?.text).toMatch(/^continuation NORM of ORIG \(fix\) finished: rc=0; merge with pai worker merge NORM/);
  });

  it("a harness run with unmerged work is absent from pending; a session worker still shows", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "t@t");
    sh(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "f"), "0");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
    const logDir = join(dir, "logs");
    const tree = (id: string): { dir: string; branch: string } => {
      const d = join(logDir, "worktrees", id);
      mkdirSync(join(logDir, "worktrees"), { recursive: true });
      sh(repo, "worktree", "add", "-q", "-b", `pai/${id}`, d);
      writeFileSync(join(d, `${id}.txt`), id);
      sh(d, "add", "."); sh(d, "commit", "-qm", `work ${id}`);
      return { dir: d, branch: `pai/${id}` };
    };
    const ts = tree("SMOKE"), tn = tree("NORM");
    saveStatus(logDir, mk("SMOKE", { origin: "harness", label: "merge gate smoke start", cwd: repo, worktreeDir: ts.dir, branch: ts.branch }));
    saveStatus(logDir, mk("NORM", { cwd: repo, worktreeDir: tn.dir, branch: tn.branch }));
    const { pendingResults } = await import("./pending.js");
    expect(pendingResults(logDir, repo).map((r) => r.id)).toEqual(["NORM"]);
  });

  it("the smoke start's env carries PAI_HARNESS_RUN=1 and drops the worker identity", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const { smokeStart } = await import("./smoke-start.js");
    const res = await smokeStart(
      { cwd: dir, timeoutMs: 1_000 },
      {
        serve: async () => ({ url: "http://127.0.0.1:1/v1", close: async () => {} }),
        addProvider: () => {},
        removeProvider: () => {},
        env: { PAI_WORKER: "x", PAI_WORKER_ID: "x", PAI_WORKER_ORCHESTRATOR: "1", CLAUDE_CODE_SESSION_ID: "s", PAI_HARNESS_RUN: "0" },
        start: async (o) => { seen = o.env; return { rc: 1, id: "smoke-test" }; },
      }
    );
    expect(res.ok).toBe(false);
    expect(seen?.PAI_HARNESS_RUN).toBe("1");
    expect(seen?.PAI_WORKER).toBeUndefined();
    expect(seen?.PAI_WORKER_ID).toBeUndefined();
    expect(seen?.PAI_WORKER_ORCHESTRATOR).toBeUndefined();
    expect(seen?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it("the smoke start's production spawn path (startDetachedWorker) hands PAI_HARNESS_RUN=1 to the child; pooled and rerouted runs keep harness", async () => {
    const { smokeStart } = await import("./smoke-start.js");
    const { pooledOrigin } = await import("./status.js");
    const { workersLogDir } = await import("./paths.js");
    const { readWorkersSection } = await import("./config.js");
    let seen: NodeJS.ProcessEnv | undefined;
    const spawnFake = ((bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }) => {
      seen = o.env;
      writeFileSync(o.env[ID_FILE_ENV]!, JSON.stringify({ id: "smoke-x", state: "running" }));
      saveStatus(workersLogDir(readWorkersSection().workers), { ...queued({ id: "smoke-x", state: "failed" }), rc: 1, origin: "harness" });
      return process.pid;
    }) as typeof import("./reroute.js").spawnSession;
    await smokeStart(
      { cwd: dir, timeoutMs: 3_000 },
      { serve: async () => ({ url: "http://127.0.0.1:1/v1", close: async () => {} }), addProvider: () => {}, removeProvider: () => {}, env: { PAI_HARNESS_RUN: "0" }, spawn: spawnFake }
    );
    expect(seen?.PAI_HARNESS_RUN).toBe("1");
    expect(pooledOrigin({ origin: "harness" })).toBe("harness");
    expect(pooledOrigin({ origin: "spawn" })).toBe("spawn");
    expect(pooledOrigin(null)).toBe("spawn");
    // a continuation of a harness run (fall-through) is spawned with the marker too
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), state: "running", origin: "harness" }));
    const seen2: NodeJS.ProcessEnv[] = [];
    const fakeStart = ((bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }) => {
      seen2.push(o.env);
      writeFileSync(o.env[RERUN_ID_FILE_ENV]!, "w2");
      writeFileSync(o.env[ID_FILE_ENV]!, "w2");
      return 4242;
    }) as typeof import("./reroute.js").spawnSession;
    await defaultSpawn(dir, fakeStart)({ id: "w1", why: "x", provider: "fakeB", specFile: join(dir, "spec.txt") });
    expect(seen2[0]?.PAI_HARNESS_RUN).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// a failure notice names the continuation the harness already started, so the
// owning session waits instead of restarting a duplicate in the gap (2026-11-24, twice)
describe("failure notices carry the escalation decision", () => {
  const mk = (id: string, over: Partial<WorkerStatus>): WorkerStatus =>
    ({ id, pid: 0, label: "fix", cwd: "/", term: "", provider: "p", model: "m", state: "done", started: nowStamp(), updated: nowStamp(), turns: 1, tools: 0, last: "", rc: 0, secs: 1, spawnerSession: "L0", ...over }) as WorkerStatus;

  it("a failed origin with a live cloud continuation names it; a cloud run with none says so", async () => {
    saveStatus(dir, mk("ORIG", { state: "failed", rc: 143, provider: "gyro", escalatedTo: "CONT" }));
    saveStatus(dir, mk("CONT", { provider: "anthropic-native", state: "running", fallThroughOf: "ORIG" }));
    saveStatus(dir, mk("CLOUD", { state: "failed", rc: 1, provider: "anthropic-native" }));
    const { detectSupervisionEvents } = await import("./supervision.js");
    const ev = await detectSupervisionEvents([loadStatus(dir, "ORIG")!, loadStatus(dir, "CONT")!, loadStatus(dir, "CLOUD")!], { now: new Date(), stallMs: 600_000 });
    const orig = ev.find((e) => e.worker === "ORIG");
    expect(orig?.text).toMatch(/^worker ORIG fix failed rc=143; escalating to anthropic-native as CONT \(same branch\) - wait for it, do not restart/);
    const cloud = ev.find((e) => e.worker === "CLOUD");
    expect(cloud?.text).toContain("no escalation: the run ended without a continuation");
  });

  it("continuationNote: a live continuation is named, a dead one and a plain failure say no escalation", async () => {
    const { continuationNote } = await import("./run/execute-fold.js");
    saveStatus(dir, mk("ORIG", { state: "failed", rc: 143, provider: "gyro", fallThroughTo: "CONT" }));
    saveStatus(dir, mk("CONT", { provider: "anthropic-native", state: "running", fallThroughOf: "ORIG" }));
    expect(continuationNote(dir, "ORIG")).toBe("escalating to anthropic-native as CONT (same branch) - wait for it, do not restart");
    saveStatus(dir, { ...loadStatus(dir, "CONT")!, state: "lost" } as WorkerStatus);
    expect(continuationNote(dir, "ORIG")).toBe("no escalation: continuation CONT is gone");
    saveStatus(dir, mk("PLAIN", { state: "failed", rc: 1 }));
    expect(continuationNote(dir, "PLAIN")).toBe("no escalation: the run ended without a continuation");
    expect(continuationNote(dir, "GONE")).toBe("no escalation: status gone");
  });

  // 2026-11-26: a continuation that committed read as "is gone" and L0 restarted finished work.
  it("a continuation that finished clean is reported as finished, not gone", async () => {
    const { continuationNote } = await import("./run/execute-fold.js");
    saveStatus(dir, mk("ORIG", { state: "killed", rc: 143, provider: "gyro", fallThroughTo: "CONT" }));
    saveStatus(dir, mk("CONT", { provider: "anthropic-native", state: "done", rc: 0, fallThroughOf: "ORIG" }));
    expect(continuationNote(dir, "ORIG")).toBe("no escalation: continuation CONT finished");
    // the failure notice carries the same clause
    saveStatus(dir, mk("ORIG2", { state: "killed", rc: 143, provider: "gyro", escalatedTo: "CONT2" }));
    saveStatus(dir, mk("CONT2", { provider: "anthropic-native", state: "done", rc: 0, fallThroughOf: "ORIG2" }));
    const { detectSupervisionEvents } = await import("./supervision.js");
    const ev = await detectSupervisionEvents([loadStatus(dir, "ORIG2")!, loadStatus(dir, "CONT2")!], { now: new Date(), stallMs: 600_000 });
    expect(ev.find((e) => e.worker === "ORIG2")?.text).toContain("no escalation: continuation CONT2 finished");
    expect(ev.find((e) => e.worker === "ORIG2")?.text).not.toContain("is gone");
  });
});

// ---------------------------------------------------------------------------
// The loop guard kills a run from OUTSIDE (SIGTERM -> rc 143, state killed): the runner's own
// escalation path never runs, so the daemon must escalate it once to the cloud like a no-convergence
// stop. It did not (2026-11-26: two loop-stopped local runs parked with "no escalation").
// ---------------------------------------------------------------------------
describe("a loop-guard stop escalates once to the cloud", () => {
  const pol = { queuedMaxMin: 15, stallCalls: 60, stallFailedCalls: 6 };
  // the daemon's view of a run the guard killed: terminal, marked, with its spec kept
  const loopStop = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
    queued({ state: "killed", rc: 143, loopStopped: true, promptFile: join(dir, "spec.txt"), branch: "worker/w1", last: "loop guard: repeated identical failing Bash calls", spawnerSession: "L0", ...over });

  it("escalateOverdue starts exactly one continuation on the fallback, same branch, and the notice names it", async () => {
    saveStatus(dir, loopStop());
    const spawned: string[] = [];
    const done = await escalateOverdue([loadStatus(dir, "w1")!], {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "d" }),
      kill: async () => [],
      spawn: (s: SpawnSpec) => { spawned.push(s.id); return undefined; },
    }, Date.now(), pol);
    expect(done.map((e) => e.id)).toEqual(["w1"]);
    expect(done[0]!.reason).toMatch(/^loop-guard stop/);
    expect(spawned).toEqual(["w1"]);
    expect(loadStatus(dir, "w1")!.rerouted).toContain("fakeB");
    // the continuation's spec carries the branch it continues and why it was stopped
    const spec = readFileSync(join(dir, "w1.reroute.prompt"), "utf8");
    expect(spec).toContain("worker/w1");
    expect(spec).toContain("loop guard");
    expect(spec).toContain("do the thing");
    // a second tick never starts another one
    await escalateOverdue([loadStatus(dir, "w1")!], { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: (s: SpawnSpec) => { spawned.push(s.id); } }, Date.now(), pol);
    expect(spawned).toEqual(["w1"]);
  });

  it("a loop-stopped run already on the fallback provider is not escalated further", async () => {
    saveStatus(dir, loopStop({ provider: "fakeB" }));
    const spawned: string[] = [];
    const done = await escalateOverdue([loadStatus(dir, "w1")!], {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "d" }),
      kill: async () => [],
      spawn: (s: SpawnSpec) => { spawned.push(s.id); return undefined; },
    }, Date.now(), pol);
    expect(done).toEqual([]);
    expect(spawned).toEqual([]);
    expect(loadStatus(dir, "w1")!.rerouted).toContain("nothing to escalate to");
  });

  it("the local-only window holds a loop-guard stop back with the reason", async () => {
    const loFile = join(dir, "local-only.json");
    writeFileSync(loFile, JSON.stringify({ untilMs: Date.now() + 60_000, label: "later", by: "budget" }), "utf8");
    process.env.PAI_LOCAL_ONLY_FILE = loFile;
    try {
      saveStatus(dir, loopStop());
      const spawned: string[] = [];
      const done = await escalateOverdue([loadStatus(dir, "w1")!], {
        logDir: dir,
        resolve: async () => ({ provider: "fakeB", description: "d" }),
        kill: async () => [],
        spawn: (s: SpawnSpec) => { spawned.push(s.id); return undefined; },
      }, Date.now(), pol);
      expect(done).toEqual([]);
      expect(spawned).toEqual([]);
      expect(loadStatus(dir, "w1")!.rerouted).toBeUndefined(); // the window keeps its marker clean for a later tick
    } finally {
      delete process.env.PAI_LOCAL_ONLY_FILE;
    }
  });

  it("an existing kill of a terminal run still refuses: only a loop-guard stop restarts", async () => {
    saveStatus(dir, queued({ state: "killed", rc: 143, promptFile: join(dir, "spec.txt") })); // killed by the operator, not the guard
    await expect(rerouteWorker("w1", "cloud", { logDir: dir, resolve: async () => ({ provider: "fakeB", description: "d" }), kill: async () => [], spawn: () => undefined })).rejects.toThrow(/is killed/);
  });
});
