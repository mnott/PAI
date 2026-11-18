import { describe, expect, it } from "vitest";
import { freshLoadWatchState, loadWatchConfig, loadWatchTick, selectSuspects, stepLoadWatch, type LoadWatchDeps, type PsRow } from "./load-watch.js";
import {
  lowPriorityConfig,
  lowPriorityKeeperTick,
  lowPriorityStatusLine,
  freshKeeperState,
  type KeeperDeps,
} from "./low-priority-keeper.js";
import {
  AUTOSTART_MAX_FAILURES,
  AUTOSTART_RETRY_MS,
  freshAutostartStates,
  isAlreadyUp,
  runtimeAutostartConfig,
  runtimeAutostartTick,
  type AutostartDeps,
} from "./runtime-autostart.js";
import { freeMemoryGb, DEFAULT_RESERVE_GB, type MemoryDeps } from "../workers/local-memory.js";
import { parseVmStat } from "../router/system.js";
import type { WorkerStatus } from "../workers/status.js";
import type { LocalTier } from "../workers/local-tiers.js";

const cfg = loadWatchConfig(undefined);
const MIN = 60_000;

describe("threshold and duration", () => {
  it("starts only after N minutes over, resets when load dips, thaws after 5 under", () => {
    let r = stepLoadWatch(freshLoadWatchState(), 50, 30, cfg, 0);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 50, 30, cfg, 9 * MIN);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 10, 30, cfg, 9.5 * MIN);
    r = stepLoadWatch(r.state, 50, 30, cfg, 10 * MIN);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 50, 30, cfg, 21 * MIN);
    expect(r.step).toBe("start");
    r = stepLoadWatch(r.state, 5, 30, cfg, 22 * MIN);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 5, 30, cfg, 27 * MIN);
    expect(r.step).toBe("thaw");
  });
});

const st = (id: string, state: string): WorkerStatus => ({ id, state } as unknown as WorkerStatus);
const row = (pid: number, ppid: number, cpu: number, command: string): PsRow => ({ pid, ppid, cpu, etime: "01:00", command });

describe("suspect selection", () => {
  it("ties an orphan in a scratch dir to its worker; unrelated busy process is not a suspect", () => {
    const rows = [
      row(11, 1, 99, "/bin/bash /tmp/pai-scratch/w-ended/loop.sh"),
      row(12, 1, 99, "/bin/bash /tmp/pai-scratch/w-live/loop.sh"),
      row(13, 1, 99, "/usr/bin/some-compiler --big"),
      row(14, 1, 80, "/bin/zsh -c while true; do :; done"),
    ];
    const s = selectSuspects(rows, [st("w-ended", "done"), st("w-live", "running")], "/logs/workers", 1);
    expect(s.map((x) => [x.pid, x.workerEnded])).toEqual([[11, true], [12, false], [14, false]]);
  });
});

describe("episode", () => {
  it("kills only the ended worker's orphan, reports the rest, alerts once per episode", async () => {
    const rows = [row(11, 1, 99, "/bin/bash /tmp/pai-scratch/w-ended/loop.sh"), row(13, 1, 99, "/usr/bin/other"), row(14, 1, 90, "/bin/zsh -c x")];
    const log = { kills: [] as number[], alerts: [] as string[], ledger: [] as string[], freezes: 0 };
    let now = 0;
    const d: LoadWatchDeps = {
      load5: () => 100,
      cores: () => 10,
      ps: async () => rows,
      statuses: () => [st("w-ended", "failed")],
      freeze: async () => (log.freezes++, "frozen"),
      thaw: async () => "thawed",
      kill: (p) => void log.kills.push(p),
      alert: async (t) => void log.alerts.push(t),
      ledger: (e, kv) => void log.ledger.push(`${e} pid=${kv.pid}`),
      write: () => undefined,
      now: () => now,
      self: 999,
      logDir: "/logs/workers",
    };
    let state = freshLoadWatchState();
    for (let i = 0; i < 25; i++) {
      state = await loadWatchTick(state, cfg, d);
      now += MIN;
    }
    expect(log.alerts).toHaveLength(1);
    expect(log.freezes).toBe(1);
    expect(log.kills).toEqual([11]);
    expect(log.ledger).toEqual(["LOADWATCH-KILL pid=11"]);
    expect(log.alerts[0]).toContain("14");
    expect(log.alerts[0]).toContain("load 100.0");
    expect(log.alerts[0]).toContain("killed 1".replace("k","K"));
    // load drops: one thaw line
    d.load5 = () => 1;
    for (let i = 0; i < 6; i++) {
      state = await loadWatchTick(state, cfg, d);
      now += MIN;
    }
    expect(log.alerts).toHaveLength(2);
    expect(log.alerts[1]).toContain("back under");
  });
});

// ---------------------------------------------------------------------------
// Runtime autostart (src/daemon/runtime-autostart.ts) — the daemon starts the
// local model runtimes marked models.runtimes.<name>.autostart when they are
// down (2026-11-18: after a reboot gyro-l stayed down all day; the router never
// routes to a provider that is down, so nothing ever started it).
// ---------------------------------------------------------------------------

const autostartTier = (provider: string, memoryGb?: number): LocalTier =>
  ({ tier: provider, engine: "vllm-mlx", provider, label: provider, model: "", served: "", port: 8035, flags: [], maxInstances: 1, location: "", health: "", ...(memoryGb !== undefined ? { memoryGb } : {}) }) as LocalTier;

const autostartCfg = runtimeAutostartConfig(
  { "gyro-l": { start: "start gyro-l", ready: "http://127.0.0.1:8035/v1/models", autostart: true }, ollama: { start: "ollama serve" } },
  [autostartTier("gyro-l", 48)]
);
// the same cfg with ollama marked autostart too (the incident's second runtime: its start refused "ollama is already running")
const autostartCfgBoth = runtimeAutostartConfig(
  { "gyro-l": { start: "start gyro-l", ready: "http://127.0.0.1:8035/v1/models", autostart: true }, ollama: { start: "ollama serve", autostart: true } },
  [autostartTier("gyro-l", 48)]
);

// injected `vm_stat` output at a 16K page size (the incident machine): the figures are exact multiples of a 16K page
const GB = 1024 ** 3;
const PAGE = 16_384;
const pagesOf = (gb: number): string => String(Math.round((gb * GB) / PAGE)).padStart(20);
const vmStatOut = (freeGb: number, inactiveGb: number, purgeableGb: number): string =>
  `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)
Pages free:${pagesOf(freeGb)}.
Pages active:${pagesOf(46)}.
Pages inactive:${pagesOf(inactiveGb)}.
Pages speculative:${pagesOf(0)}.
Pages throttled:${"0".padStart(20)}.
Pages wired down:${pagesOf(18)}.
Pages purgeable:${pagesOf(purgeableGb)}.
Pages stored in compressor:${pagesOf(6)}.
Pages occupied by compressor:${pagesOf(4)}.
`;
const memDeps = (out: string, totalBytes: number, level?: number): MemoryDeps => ({
  vmStat: async () => out,
  memTotal: async () => totalBytes,
  pressureLevel: async () => level,
});

interface Autolog { starts: string[]; alerts: string[]; ledger: string[]; lines: string[] }

const autostartDeps = (log: Autolog, over: Partial<AutostartDeps> = {}): AutostartDeps => ({
  isUp: async () => false,
  frozen: () => false,
  freeGb: async () => 100,
  start: async (r) => {
    log.starts.push(r);
    return { ok: true, message: `${r} up` };
  },
  alert: async (t) => void log.alerts.push(t),
  ledger: (e, kv) => void log.ledger.push(`${e} ${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(" ")}`),
  log: (x) => void log.lines.push(x),
  now: () => 0,
  ...over,
});

describe("runtime autostart", () => {
  it("a local_tiers model (apple-fm) with only autostart:true and no start command starts as a tier, up-check first", async () => {
    const cfg = runtimeAutostartConfig({ "apple-fm": { autostart: true } }, [autostartTier("apple-fm", 8)]);
    expect(cfg.enabled).toBe(true);
    expect(cfg.tiers?.["apple-fm"]?.tier).toBe("apple-fm");
    expect(cfg.memoryGb["apple-fm"]).toBe(8);
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    expect(await runtimeAutostartTick(cfg, freshAutostartStates(), autostartDeps(log, { isUp: async () => true, freeGb: async () => 1 }))).toEqual([]);
    expect(await runtimeAutostartTick(cfg, freshAutostartStates(), autostartDeps(log, { freeGb: async () => 4 }))).toEqual([{ kind: "skip-memory", runtime: "apple-fm", needGb: 8, freeGb: 4 }]);
    expect(await runtimeAutostartTick(cfg, freshAutostartStates(), autostartDeps(log))).toEqual([{ kind: "start", runtime: "apple-fm" }]);
    expect(runtimeAutostartConfig({ nothing: { autostart: true } }, [autostartTier("apple-fm")]).enabled).toBe(false); // no start command, no tier: nothing to start
  });

  it("starts a down autostart runtime once; one without autostart is never touched", async () => {
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let up = false;
    const d = autostartDeps(log, {
      isUp: async (r) => (r === "gyro-l" ? up : false),
      start: async (r) => {
        log.starts.push(r);
        up = true;
        return { ok: true, message: `${r} up` };
      },
    });
    const states = freshAutostartStates();
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]);
    expect(log.starts).toEqual(["gyro-l"]); // ollama has no autostart: never started
    expect(log.ledger[0]).toContain("RUNTIME-AUTOSTART runtime=gyro-l result=ok");
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([]);
    expect(log.starts).toEqual(["gyro-l"]); // the up runtime is started once
  });

  it("not enough memory: skip with no alert and no start; retried on later ticks; starts when memory frees", async () => {
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let free = 10; // below the tier's 48 GB
    const d = autostartDeps(log, { freeGb: async () => free });
    const states = freshAutostartStates();
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "skip-memory", runtime: "gyro-l", needGb: 48, freeGb: 10 }]);
    expect(log.starts).toEqual([]);
    // a skip alone never alerts (the alert follows a real failed start — see the failure tests): only the log line names the measured numbers
    expect(log.alerts).toEqual([]);
    expect(log.lines.some((x) => x.includes("skipped") && x.includes("needs ~48 GB") && x.includes("available 10 GB"))).toBe(true);
    // a skip is not a failure: retried on later ticks, still no alert
    await runtimeAutostartTick(autostartCfg, states, d);
    expect(log.alerts).toEqual([]);
    expect(log.starts).toEqual([]);
    free = 60;
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]);
    expect(log.starts).toEqual(["gyro-l"]);
  });

  it("a frozen machine starts nothing; the thaw starts it", async () => {
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let frozen = true;
    const d = autostartDeps(log, { frozen: () => frozen });
    const states = freshAutostartStates();
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([]);
    expect(log.starts).toEqual([]);
    frozen = false;
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]);
    expect(log.starts).toEqual(["gyro-l"]);
  });

  it("failures retry at most every 10 min and stop after 3 until the next daemon start", async () => {
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let now = 0;
    const d = autostartDeps(log, {
      start: async (r) => {
        log.starts.push(r);
        return { ok: false, message: "engine died" };
      },
      now: () => now,
    });
    const states = freshAutostartStates();
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]);
    now += 5 * MIN; // inside the backoff: no retry
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([]);
    expect(log.starts).toHaveLength(1);
    now += 5 * MIN + 1; // out of it: failure 2
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]);
    now += AUTOSTART_RETRY_MS;
    await runtimeAutostartTick(autostartCfg, states, d); // failure 3 = the cap
    expect(log.starts).toHaveLength(AUTOSTART_MAX_FAILURES);
    expect(log.lines.some((x) => x.includes("giving up until the next daemon start"))).toBe(true);
    now += 60 * MIN; // given up: nothing more, however long it stays down
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([]);
    expect(log.starts).toHaveLength(AUTOSTART_MAX_FAILURES);
    // a fresh manager (a daemon start) resets the count and tries again
    expect(await runtimeAutostartTick(autostartCfg, freshAutostartStates(), d)).toEqual([{ kind: "start", runtime: "gyro-l" }]);
    expect(log.starts).toHaveLength(AUTOSTART_MAX_FAILURES + 1);
  });

  it("a runtime that dies again later is restarted with the same backoff", async () => {
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let now = 0;
    let up = false;
    const d = autostartDeps(log, {
      isUp: async () => up,
      start: async (r) => {
        log.starts.push(r);
        return { ok: false, message: "engine died" }; // the restart attempt fails too: the backoff applies to it
      },
      now: () => now,
    });
    const states = freshAutostartStates();
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]); // the boot start (fails)
    up = true; // it came up after all
    now += MIN;
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([]); // up: nothing to do, the failure count resets
    up = false; // it dies again
    now += MIN;
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]); // restarted at once (the count was reset)
    up = false;
    now += AUTOSTART_RETRY_MS - 1; // inside the next backoff window after the failed restart
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([]);
    now += 2;
    expect(await runtimeAutostartTick(autostartCfg, states, d)).toEqual([{ kind: "start", runtime: "gyro-l" }]); // out of it: retried, never in a tight loop
    expect(log.starts).toHaveLength(3);
  });

  // the reboot incident's memory guard: only "free" pages counted → "needs ~60 GB,
  // free 25 GB" on a 128 GB machine with ~90 GB reclaimable. Available = free +
  // inactive + speculative + purgeable, and a skip alone never alerts.
  it("memory: vm_stat free 25 GB with 90 GB available (inactive+purgeable) starts; 20 GB available skips without an alert", async () => {
    const total = 128 * GB;
    // the incident shape: free 25 GB, free+inactive+purgeable 90 GB
    const roomy = vmStatOut(25, 61.375, 3.625);
    expect(parseVmStat(roomy, total)?.available).toBe(90 * GB);
    expect(await freeMemoryGb(0, memDeps(roomy, total))).toBe(90); // the autostart measure: no reserve
    expect(await freeMemoryGb(DEFAULT_RESERVE_GB, memDeps(roomy, total))).toBe(86);
    // only 20 GB anywhere available
    const tight = vmStatOut(20, 0, 0);
    expect(await freeMemoryGb(0, memDeps(tight, total))).toBe(20);

    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    const d = autostartDeps(log, { freeGb: () => freeMemoryGb(0, memDeps(roomy, total)) });
    expect(await runtimeAutostartTick(autostartCfg, freshAutostartStates(), d)).toEqual([{ kind: "start", runtime: "gyro-l" }]); // 90 GB available ≥ 48 GB need: started (old code: skipped)
    expect(log.starts).toEqual(["gyro-l"]);
    expect(log.alerts).toEqual([]);

    const log2: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    const d2 = autostartDeps(log2, { freeGb: () => freeMemoryGb(0, memDeps(tight, total)) });
    const states = freshAutostartStates();
    expect(await runtimeAutostartTick(autostartCfg, states, d2)).toEqual([{ kind: "skip-memory", runtime: "gyro-l", needGb: 48, freeGb: 20 }]);
    expect(log2.starts).toEqual([]);
    expect(log2.lines.some((x) => x.includes("skipped") && x.includes("available 20 GB"))).toBe(true); // the measured numbers are logged
    await runtimeAutostartTick(autostartCfg, states, d2);
    expect(log2.alerts).toEqual([]); // a skip is not a failure: no alert for a skip alone
  });

  // 13:46 incident: gyro-l answered 200 on its ready URL and the tick still
  // logged a skip + sent a "not enough memory" alert; ollama's start refused
  // "ollama is already running" and that refusal burned a failure attempt.
  it("an up runtime is left alone: no memory probe, no start, no alert even when available memory is short", async () => {
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let freeCalls = 0;
    const d = autostartDeps(log, {
      isUp: async (r) => r === "gyro-l", // gyro-l answers its ready URL
      freeGb: async () => {
        freeCalls++;
        return 10; // far below the 48 GB need — must never be consulted for an up runtime
      },
    });
    expect(await runtimeAutostartTick(autostartCfgBoth, freshAutostartStates(), d)).toEqual([{ kind: "start", runtime: "ollama" }]); // only the down one acts
    expect(log.starts).toEqual(["ollama"]);
    expect(freeCalls).toBe(0); // the readiness probe is the first word per runtime
    expect(log.alerts).toEqual([]);
    expect(log.lines.some((x) => x.includes("gyro-l"))).toBe(false); // gyro-l: nothing at all logged for it
  });

  it(`"already running" from the start command is success: no failure attempt, no alert; a real failure alerts once`, async () => {
    expect(isAlreadyUp("ollama is already running (http://127.0.0.1:11434)")).toBe(true);
    expect(isAlreadyUp("gyro-l is already starting (job ab12cd)")).toBe(true);
    expect(isAlreadyUp("engine died on startup")).toBe(false);
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let now = 0;
    // gyro-l's start fails for real every time; ollama's refuses "already running" (the incident: `ollama serve` found its server up)
    const d = autostartDeps(log, {
      start: async (r) => {
        log.starts.push(r); // the shared stub must still record the attempt
        return r === "ollama" ? { ok: false, message: "ollama is already running (http://127.0.0.1:11434)" } : { ok: false, message: "engine died" };
      },
      now: () => now,
    });
    const states = freshAutostartStates();
    expect(await runtimeAutostartTick(autostartCfgBoth, states, d)).toEqual([
      { kind: "start", runtime: "gyro-l" },
      { kind: "start", runtime: "ollama" },
    ]);
    // gyro-l: a real failure — ledger error and ONE alert naming it
    expect(states.get("gyro-l")).toMatchObject({ attempts: 1 });
    expect(log.ledger.some((x) => x.includes("runtime=gyro-l result=error: engine died"))).toBe(true);
    expect(log.alerts).toHaveLength(1);
    expect(log.alerts[0]).toContain("gyro-l");
    expect(log.alerts[0]).toContain("start failed");
    // ollama: the refusal reads up — ledger ok, no failure attempt (no backoff opens), and it never alerts
    expect(states.get("ollama")).toMatchObject({ attempts: 0, gaveUp: false });
    expect(log.ledger.some((x) => x.includes("runtime=ollama result=ok"))).toBe(true);
    now += MIN; // gyro-l is inside its backoff; ollama is retried every tick — a refusal never starts one
    await runtimeAutostartTick(autostartCfgBoth, states, d);
    expect(log.starts.filter((x) => x === "gyro-l")).toHaveLength(1);
    expect(log.starts.filter((x) => x === "ollama")).toHaveLength(2);
    expect(log.alerts).toHaveLength(1); // still one: ollama's repeated refusal never alerts
    now += AUTOSTART_RETRY_MS;
    await runtimeAutostartTick(autostartCfgBoth, states, d); // gyro-l failure 2: still one alert
    expect(log.alerts).toHaveLength(1);
    now += AUTOSTART_RETRY_MS;
    await runtimeAutostartTick(autostartCfgBoth, states, d); // failure 3 = the give-up: one final alert
    expect(states.get("gyro-l")).toMatchObject({ gaveUp: true });
    expect(log.alerts).toHaveLength(2);
    expect(log.alerts[1]).toContain("giving up");
  });

  it("a memory skip never alerts; the first real failed start alerts once", async () => {
    const log: Autolog = { starts: [], alerts: [], ledger: [], lines: [] };
    let free = 10; // below the tier's 48 GB
    const d = autostartDeps(log, { freeGb: async () => free });
    const states = freshAutostartStates();
    for (let i = 0; i < 3; i++) await runtimeAutostartTick(autostartCfg, states, d); // three skips
    expect(log.alerts).toEqual([]);
    expect(log.starts).toEqual([]);
    free = 60; // memory frees: the start runs and fails for real
    const failed = autostartDeps(log, { freeGb: async () => free, start: async (r) => ({ ok: false, message: "engine died" }) });
    expect(await runtimeAutostartTick(autostartCfg, states, failed)).toEqual([{ kind: "start", runtime: "gyro-l" }]);
    expect(log.alerts).toHaveLength(1); // one alert, only now — after a real failed start
    expect(log.alerts[0]).toContain("start failed");
  });
});

// ---------------------------------------------------------------------------
// Low-priority keeper (src/daemon/low-priority-keeper.ts) — the daemon keeps
// listed background apps (seaf-daemon) at background CPU priority after every
// restart of theirs (2026-11-18: seaf-daemon scanned all libraries at ~90-100%
// for minutes after each reboot and each PAI merge).
// ---------------------------------------------------------------------------

const keeperCfg = lowPriorityConfig({ lowPriority: { processes: ["seaf-daemon"] } });

interface KeeperLog { pgreps: string[]; policies: number[]; lines: string[] }

/** Injected pgrep/taskpolicy: `prios` is pid -> pri, a missing entry reads gone. */
const keeperDeps = (log: KeeperLog, prios: Map<number, number>, unchangeable: number[] = []): KeeperDeps => ({
  pgrep: async (name) => {
    log.pgreps.push(name);
    return [...prios.keys()].join("\n");
  },
  psPri: async (pid) => (prios.has(pid) ? `  ${prios.get(pid)}\n` : ""),
  taskpolicy: async (pid) => {
    if (unchangeable.includes(pid)) throw new Error("Operation not permitted");
    log.policies.push(pid);
    prios.set(pid, 4); // the real command lands a process at scheduler pri 4
  },
  log: (l) => void log.lines.push(l),
  write: () => undefined,
  now: () => 0,
});

describe("low priority keeper", () => {
  it("only exact names are looked up; default config lists nothing", () => {
    expect(lowPriorityConfig(undefined).processes).toEqual([]); // default: off by emptiness
    const log: KeeperLog = { pgreps: [], policies: [], lines: [] };
    const prios = new Map([[1468, 31]]);
    void lowPriorityKeeperTick(keeperCfg, freshKeeperState(), keeperDeps(log, prios));
    expect(log.pgreps).toEqual(["seaf-daemon"]); // pgrep -x takes the exact name as given, never a pattern
  });

  it("a normal-priority pid is lowered once and logged once; an already-background pid is not touched again", async () => {
    const log: KeeperLog = { pgreps: [], policies: [], lines: [] };
    const prios = new Map([[1468, 31], [2000, 4]]); // 2000 came up background already
    const states = freshKeeperState();
    const d = keeperDeps(log, prios);
    await lowPriorityKeeperTick(keeperCfg, states, d);
    expect(log.policies).toEqual([1468]); // the normal one lowered, the background one untouched
    expect(log.lines.filter((l) => l.includes("pid 1468"))).toHaveLength(1);
    for (let i = 0; i < 3; i++) await lowPriorityKeeperTick(keeperCfg, states, d);
    expect(log.policies).toEqual([1468]); // still one apply: it reads background now
    expect(log.lines.filter((l) => l.includes("pid 1468"))).toHaveLength(1); // and still one log line
    expect(log.lines.filter((l) => l.includes("pid 2000"))).toEqual([]); // never touched, never logged
  });

  it("an unchangeable pid is skipped with exactly one log line across later passes", async () => {
    const log: KeeperLog = { pgreps: [], policies: [], lines: [] };
    const prios = new Map([[900, 31]]); // root-owned: taskpolicy refuses it
    const states = freshKeeperState();
    const d = keeperDeps(log, prios, [900]);
    await lowPriorityKeeperTick(keeperCfg, states, d);
    expect(log.policies).toEqual([]);
    for (let i = 0; i < 4; i++) await lowPriorityKeeperTick(keeperCfg, states, d);
    expect(log.lines.filter((l) => l.includes("pid 900"))).toHaveLength(1); // skipped, logged once
    expect(log.lines[0]).toContain("skipped");
  });

  it("the status line names each tracked pid the way `pai daemon status` prints it", async () => {
    const log: KeeperLog = { pgreps: [], policies: [], lines: [] };
    const prios = new Map([[1468, 31]]);
    const status = await lowPriorityKeeperTick(keeperCfg, freshKeeperState(), keeperDeps(log, prios));
    expect(lowPriorityStatusLine(status)).toBe("Low priority: seaf-daemon (pid 1468, background)");
    expect(lowPriorityStatusLine(null)).toBeNull();
  });
});
