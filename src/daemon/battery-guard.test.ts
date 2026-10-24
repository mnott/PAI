import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The battery guard (src/daemon/battery-guard.ts): pmset parsing on real
 * output samples, the pause/stop state machine with hysteresis, the
 * draining-on-AC warning, and the worker gate refusing local work while the
 * guard is paused (cloud untouched).
 */

const root = mkdtempSync(join(tmpdir(), "pai-batteryguard-"));
const home = join(root, "home");
const logDir = join(root, "logs", "workers");

// PAI_HOME pins the guard's state files (battery-guard.json) into the temp
// home; the config pins the workers config the gate reads. Both are set
// before any import below.
process.env.PAI_HOME = home;
process.env.PAI_CONFIG_FILE = join(home, "config.yaml");
process.env.PAI_WORKERS_YAML = join(home, "workers.yaml");

const {
  parsePmsetBatt,
  parseIoregPower,
  evaluateBenchmark,
  isBenchmarkLabel,
  drainRatePctPerMin,
  evaluateBattery,
  emptyBatteryState,
  drainLine,
  batteryGuardConfig,
  batteryGateRefusal,
  batteryCockpitLine,
  localKillTargets,
  stopLocalWork,
  batteryGuardTick,
  BATTERY_GUARD_DEFAULTS,
} = await import("./battery-guard.js");
const { runWorker } = await import("../workers/run.js");
const { BatteryGuardRefusedError, batteryGuardRefusal } = await import("../workers/run/gate.js");
const { saveStatus } = await import("../workers/status.js");

type BatteryGuardConfig = NonNullable<ReturnType<typeof batteryGuardConfig>>;
type BatteryReading = Parameters<typeof parsePmsetBatt>[0] extends string ? ReturnType<typeof evaluateBattery>["state"]["readings"][number] : never;
type WorkerStatus = Parameters<typeof saveStatus>[1];

const cfg: BatteryGuardConfig = { ...BATTERY_GUARD_DEFAULTS };

const r = (at: number, pct: number | null, source: "ac" | "battery", charge: BatteryReading["charge"] = "discharging"): BatteryReading => ({
  at,
  pct,
  source,
  charge,
});

// ---------------------------------------------------------------------------
// pmset parsing — real output samples
// ---------------------------------------------------------------------------

describe("parsePmsetBatt", () => {
  // captured from this machine 2026-10-24 (pmset -g batt); pmset separates the
  // battery line's fields with a real tab
  const TAB = String.fromCharCode(9);
  const AC_CHARGING =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=37290083)" + TAB + "92%; charging; 1:02 remaining present: true\n";
  const AC_DISCHARGING =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=7077888)" + TAB + "55%; discharging; 3:14 remaining present: true\n";
  const BATTERY =
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=7077888)" + TAB + "23%; discharging; 1:47 remaining present: true\n";
  const CHARGED =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=7077888)" + TAB + "100%; charged; 0:00 remaining present: true\n";
  const NO_BATTERY = "Now drawing from 'AC Power'\n";

  it("AC charging: percent, source, charge state", () => {
    expect(parsePmsetBatt(AC_CHARGING, 1000)).toEqual({ at: 1000, pct: 92, source: "ac", charge: "charging" });
  });

  it("AC discharging (the draining-on-AC case): read as-is", () => {
    expect(parsePmsetBatt(AC_DISCHARGING, 2000)).toEqual({ at: 2000, pct: 55, source: "ac", charge: "discharging" });
  });

  it("battery power: source battery, discharging", () => {
    expect(parsePmsetBatt(BATTERY, 3000)).toEqual({ at: 3000, pct: 23, source: "battery", charge: "discharging" });
  });

  it("charged on AC", () => {
    expect(parsePmsetBatt(CHARGED, 4000)).toEqual({ at: 4000, pct: 100, source: "ac", charge: "charged" });
  });

  it("a desktop on AC with no internal battery: no percent, still a reading", () => {
    expect(parsePmsetBatt(NO_BATTERY, 5000)).toEqual({ at: 5000, pct: null, source: "ac", charge: "unknown" });
  });

  it("unparsable output is no reading at all", () => {
    expect(parsePmsetBatt("", 1)).toBeNull();
    expect(parsePmsetBatt("pmset: not available", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The state machine with hysteresis
// ---------------------------------------------------------------------------

describe("evaluateBattery", () => {
  it("ok until the pause threshold; at exactly pauseBelowPct it pauses", () => {
    let v = evaluateBattery(emptyBatteryState(), r(0, 26, "battery"), cfg);
    expect(v.state.phase).toBe("ok");
    expect(v.paused).toBe(false);
    v = evaluateBattery(v.state, r(60_000, 25, "battery"), cfg);
    expect(v.paused).toBe(true);
    expect(v.state.phase).toBe("paused");
  });

  it("hysteresis: stays paused inside the band, resumes only above pauseBelowPct + hysteresisPct", () => {
    let s = evaluateBattery(emptyBatteryState(), r(0, 25, "battery"), cfg).state;
    // 35 = pauseBelowPct + hysteresisPct: not above the line yet
    let v = evaluateBattery(s, r(60_000, 35, "battery"), cfg);
    expect(v.resumed).toBe(false);
    expect(v.state.phase).toBe("paused");
    v = evaluateBattery(v.state, r(120_000, 36, "battery"), cfg);
    expect(v.resumed).toBe(true);
    expect(v.state.phase).toBe("ok");
  });

  it("a battery hovering at the threshold re-pauses only after a full resume", () => {
    let s = evaluateBattery(emptyBatteryState(), r(0, 25, "battery"), cfg).state;
    s = evaluateBattery(s, r(60_000, 36, "battery"), cfg).state; // resumed above the line
    const v = evaluateBattery(s, r(120_000, 25, "battery"), cfg); // back at the threshold
    expect(v.paused).toBe(true);
    expect(v.state.phase).toBe("paused");
  });

  it("stop at stopBelowPct from ok in one step; one stop move, then held", () => {
    let v = evaluateBattery(emptyBatteryState(), r(0, 11, "battery"), cfg);
    expect(v.paused).toBe(true);
    expect(v.stopped).toBe(true);
    expect(v.state.phase).toBe("stopped");
    expect(v.state.lastStopAt).toBe(0);
    // the next low reading must not sweep a second time
    v = evaluateBattery(v.state, r(60_000, 10, "battery"), cfg);
    expect(v.stopped).toBe(false);
    expect(v.state.phase).toBe("stopped");
  });

  it("paused → stopped at stopBelowPct, and out only through the hysteresis line", () => {
    let s = evaluateBattery(emptyBatteryState(), r(0, 25, "battery"), cfg).state;
    let v = evaluateBattery(s, r(60_000, 12, "battery"), cfg);
    expect(v.stopped).toBe(true);
    expect(v.state.phase).toBe("stopped");
    v = evaluateBattery(v.state, r(120_000, 35, "battery"), cfg); // exactly the line: still held
    expect(v.resumed).toBe(false);
    v = evaluateBattery(v.state, r(180_000, 36, "battery"), cfg);
    expect(v.resumed).toBe(true);
    expect(v.state.phase).toBe("ok");
  });

  it("a reading with no percent never moves the phase", () => {
    let v = evaluateBattery(emptyBatteryState(), r(0, null, "ac"), cfg);
    expect(v.state.phase).toBe("ok");
    v = evaluateBattery(v.state, r(60_000, null, "battery"), cfg);
    expect(v.state.phase).toBe("ok");
  });

  it("shutdown holds the state: no pause, no stop", () => {
    const v = evaluateBattery(emptyBatteryState(), r(0, 5, "battery"), cfg, true);
    expect(v.paused).toBe(false);
    expect(v.stopped).toBe(false);
    expect(v.state.phase).toBe("ok");
  });

  it("disabled: no pause, no stop, no drain warning", () => {
    const off = { ...cfg, enabled: false };
    let s = emptyBatteryState();
    for (let i = 0; i < cfg.drainWindowReadings; i++) {
      s = evaluateBattery(s, r(i * 60_000, 60 - i, "ac", "discharging"), off).state;
    }
    const v = evaluateBattery(s, r(600_000, 5, "battery"), off);
    expect(v.paused).toBe(false);
    expect(v.stopped).toBe(false);
    expect(v.drainWarn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Draining on AC
// ---------------------------------------------------------------------------

describe("draining on AC", () => {
  it("on AC with the percent falling over the window: one warning, the line reads first → last", () => {
    let s = emptyBatteryState();
    let warned = 0;
    let line: string | null = null;
    for (let i = 0; i < cfg.drainWindowReadings; i++) {
      const v = evaluateBattery(s, r(i * 60_000, 62 - i, "ac", "discharging"), cfg);
      s = v.state;
      if (v.drainWarn) {
        warned++;
        line = drainLine(v.state.readings, cfg);
      }
    }
    expect(warned).toBe(1);
    expect(line).toBe("battery draining on AC: 62 % → 53 % in 9 min");
  });

  it("charging on AC: no warning even when the percent dips", () => {
    let s = emptyBatteryState();
    let warned = false;
    for (let i = 0; i < cfg.drainWindowReadings; i++) {
      const v = evaluateBattery(s, r(i * 60_000, 62 - i, "ac", "charging"), cfg);
      s = v.state;
      warned ||= v.drainWarn;
    }
    expect(warned).toBe(false);
  });

  it("discharging on battery: not the anomaly this check is for", () => {
    let s = emptyBatteryState();
    let warned = false;
    for (let i = 0; i < cfg.drainWindowReadings; i++) {
      const v = evaluateBattery(s, r(i * 60_000, 62 - i, "battery"), cfg);
      s = v.state;
      warned ||= v.drainWarn;
    }
    expect(warned).toBe(false);
  });

  it("a steady percent on AC is not draining", () => {
    let s = emptyBatteryState();
    let warned = false;
    for (let i = 0; i < cfg.drainWindowReadings; i++) {
      const v = evaluateBattery(s, r(i * 60_000, 62, "ac", "discharging"), cfg);
      s = v.state;
      warned ||= v.drainWarn;
    }
    expect(warned).toBe(false);
  });

  it("the warning repeats only after a full window has passed", () => {
    let s = emptyBatteryState();
    for (let i = 0; i < cfg.drainWindowReadings; i++) s = evaluateBattery(s, r(i * 60_000, 62 - i, "ac", "discharging"), cfg).state;
    // still draining, but only one tick since the warning
    expect(evaluateBattery(s, r(600_000, 52, "ac", "discharging"), cfg).drainWarn).toBe(false);
    // a full window later: the spell is still going, warn again
    expect(evaluateBattery(s, r(600_000 + cfg.drainWindowReadings * 60_000, 52, "ac", "discharging"), cfg).drainWarn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("batteryGuardConfig", () => {
  it("defaults when the block is absent", () => {
    expect(batteryGuardConfig(undefined)).toEqual(BATTERY_GUARD_DEFAULTS);
  });

  it("user values win per key, the rest stay defaults", () => {
    expect(batteryGuardConfig({ batteryGuard: { pauseBelowPct: 40, intervalSecs: 30 } })).toEqual({
      ...BATTERY_GUARD_DEFAULTS,
      pauseBelowPct: 40,
      intervalSecs: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// The gate file and the worker gate
// ---------------------------------------------------------------------------

describe("the worker gate refuses local work while paused", () => {
  it("batteryGuardRefusal: local refused with the reason, remote untouched", () => {
    const why = batteryGuardRefusal(true, logDir, "gyro-m", Date.now(), "battery at 20 % (at or below power.batteryGuard.pauseBelowPct 25)");
    expect(why).toContain('provider "gyro-m"');
    expect(why).toContain("battery guard has paused new local-model work");
    expect(why).toContain("battery at 20 %");
    expect(why).toContain("power.batteryGuard.pauseBelowPct");
    expect(batteryGuardRefusal(false, logDir, "glm", Date.now(), "battery at 20 %")).toBeNull();
    expect(batteryGuardRefusal(true, logDir, "gyro-m", Date.now(), null)).toBeNull();
  });

  it("runWorker onto a local provider: refused while the gate file says paused", async () => {
    let t = Date.now();
    let pct = 90;
    const reading = (): BatteryReading => ({ at: t, pct, source: "battery", charge: "discharging" });
    const tick = () =>
      batteryGuardTick(logDir, { providers: { up30: { baseUrl: "http://127.0.0.1:45995" } } }, cfg, {
        read: async () => reading(),
        now: () => t,
        stop: async () => [],
      });

    await tick(); // 90 %: open
    expect(batteryGateRefusal(t)).toBeNull();
    const rc = await runWorker({ providerFlag: "up30", printCmd: true, quiet: true, claudeArgs: ["-p", "x"], _localCheck: async () => true });
    expect(rc).toBe(0);

    t += 60_000; // 20 %: paused
    pct = 20;
    await tick();
    expect(batteryGateRefusal(t)).toContain("battery at 20 %");
    await expect(
      runWorker({ providerFlag: "up30", printCmd: true, quiet: true, claudeArgs: ["-p", "x"], _localCheck: async () => true })
    ).rejects.toThrow(BatteryGuardRefusedError);

    // a remote provider runs untouched while the guard is paused
    const log = console.log;
    let out = "";
    console.log = (s?: unknown) => {
      out += String(s);
    };
    try {
      expect(await runWorker({ providerFlag: "glm", printCmd: true, quiet: true, claudeArgs: ["-p", "x"], _localCheck: async () => false })).toBe(0);
      expect(JSON.parse(out).route).toContain("glm/");
    } finally {
      console.log = log;
    }

    // the refusal and the pause are on the ledger
    const ledger = readFileSync(join(logDir, "ledger.log"), "utf8");
    expect(ledger).toContain("BATTERY-GATE-REFUSED provider=up30");
    expect(ledger).toContain("BATTERY-PAUSE pct=20");
  });
});

// ---------------------------------------------------------------------------
// The stop pass
// ---------------------------------------------------------------------------

describe("stopLocalWork", () => {
  const providers = { localA: { baseUrl: "http://127.0.0.1:11434" }, cloudB: { baseUrl: "https://cloud.example.invalid" } };

  const mk = (over: Partial<WorkerStatus> & { id: string }): void => {
    const s: WorkerStatus = {
      id: over.id,
      pid: process.pid,
      label: "t",
      cwd: logDir,
      term: "",
      provider: "localA",
      model: "m",
      state: "running",
      started: "2026-10-24 10:00:00",
      updated: "2026-10-24 10:00:00",
      turns: 1,
      tools: 0,
      last: "x",
      rc: null,
      secs: null,
      origin: "spawn",
      procStart: Date.now(),
    };
    saveStatus(logDir, { ...s, ...over });
  };

  it("targets live headless runs on local providers only: no chat panes, no cloud, no dead pids", async () => {
    mk({ id: "loc-live" });
    mk({ id: "cloud-live", provider: "cloudB" });
    mk({ id: "chat-pane", origin: "chat", label: "(no prompt)", turns: 0 });
    mk({ id: "loc-dead", pid: 999_999 });
    mk({ id: "loc-done", state: "done", rc: 0 });
    expect(localKillTargets(logDir, providers)).toEqual(["loc-live"]);

    const killed: string[] = [];
    const stopped: string[] = [];
    const lines = await stopLocalWork(logDir, providers, "battery at 11 %", {
      killWorker: async (_dir, id) => {
        killed.push(id);
        return [`sent SIGTERM to worker ${id}`];
      },
      stopRuntime: async (runtime) => {
        stopped.push(runtime);
        return { ok: true, message: `${runtime} stopped` };
      },
      runtimesToStop: () => ["ollama"],
      now: () => 1_760_000_000_000,
    });
    expect(killed).toEqual(["loc-live"]);
    expect(stopped).toEqual(["ollama"]);
    expect(lines).toEqual(["sent SIGTERM to worker loc-live", "ollama: ollama stopped"]);
    const ledger = readFileSync(join(logDir, "ledger.log"), "utf8");
    expect(ledger).toContain('BATTERY-STOP reason=battery at 11 %');
    expect(ledger).toContain("BATTERY-RUNTIME-STOP runtime=ollama ok=1");
  });
});

// ---------------------------------------------------------------------------
// The tick: state files and the cockpit line
// ---------------------------------------------------------------------------

describe("batteryGuardTick", () => {
  it("writes the gate and cockpit files; the cockpit line carries the drain warning", async () => {
    const state = { current: emptyBatteryState() };
    let t = 1_760_000_100_000;
    const tick = (b: BatteryReading) =>
      batteryGuardTick(logDir, { providers: {} }, cfg, { read: async () => b, now: () => t, stop: async () => [] }, state);

    await tick(r(t, 60, "ac", "discharging"));
    expect(batteryCockpitLine(t)).toContain("60 % (AC)");
    expect(batteryCockpitLine(t)).not.toContain("draining");

    for (let i = 1; i < cfg.drainWindowReadings; i++) {
      t += 60_000;
      await tick(r(t, 60 - i, "ac", "discharging"));
    }
    expect(batteryCockpitLine(t)).toContain("battery draining on AC: 60 % → 51 % in 9 min");

    // a dead guard's stale file must never hold workers back
    expect(batteryGateRefusal(t + 10 * 60_000)).toBeNull();
    expect(batteryCockpitLine(t + 10 * 60_000)).toBe("");
  });

  it("the stop move sweeps the running local work once", async () => {
    const state = { current: emptyBatteryState() };
    let sweeps = 0;
    const t = 1_760_000_200_000;
    const v = await batteryGuardTick(
      logDir,
      { providers: { localA: { baseUrl: "http://127.0.0.1:11434" } } },
      cfg,
      { read: async () => r(t, 11, "battery"), now: () => t, stop: async () => { sweeps++; return []; } },
      state
    );
    expect(v?.stopped).toBe(true);
    expect(sweeps).toBe(1);
    expect(batteryGateRefusal(t)).toContain("stopBelowPct");
  });

  it("no reading: the tick does nothing", async () => {
    const state = { current: emptyBatteryState() };
    const v = await batteryGuardTick(logDir, { providers: {} }, cfg, { read: async () => null, stop: async () => [] }, state);
    expect(v).toBeNull();
    expect(state.current.phase).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Fixture config for runWorker (same shape as run-local-guard.test.ts)
// ---------------------------------------------------------------------------

const yaml = [
  "providers:",
  "  glm:",
  "    url: https://glm.example.invalid",
  "    models:",
  "      default: glm-big",
  "  up30:",
  "    url: http://127.0.0.1:45995",
  "    models:",
  "      default: flash-up",
  "",
].join("\n");

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(home, "config.yaml"), `workers:\n  enabled: true\n  logDir: ${logDir}\n`);
  writeFileSync(join(home, "workers.yaml"), yaml);
}, 10_000);

afterAll(() => {
  delete process.env.PAI_HOME;
  delete process.env.PAI_CONFIG_FILE;
  delete process.env.PAI_WORKERS_YAML;
  try {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(process.cwd(), ".pai-scratch", `batteryguard-${process.pid}`), { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// ioreg power telemetry — real output sample
// ---------------------------------------------------------------------------

describe("parseIoregPower", () => {
  // captured from this machine 2026-10-24 (ioreg -rn AppleSmartBattery), the lines the parser reads
  const IOREG =
    '+-o AppleSmartBattery  <class AppleSmartBattery>\n' +
    '  | {\n' +
    '  |   "AdapterDetails" = {"IsWireless"=No,"AdapterID"=0,"AdapterVoltage"=20000,"Watts"=100,"Current"=4990,"Description"="pd charger"}\n' +
    '  |   "ExternalConnected" = Yes\n' +
    '  |   "PowerTelemetryData" = {"SystemEnergyConsumed"=19031,"SystemLoad"=68735,"SystemPowerIn"=68514,"BatteryPower"=18446744073709551395,"PowerTelemetryErrorCount"=0}\n' +
    '  |   "MaxCapacity" = 100\n' +
    '  |   "CurrentCapacity" = 100\n' +
    '  |   "BatteryData" = {"CurrentCapacity"=100,"MaxCapacity"=100}\n' +
    '  | }\n';

  it("adapter watts, SystemPowerIn, SystemLoad, signed battery watts, percent", () => {
    expect(parseIoregPower(IOREG, 7)).toEqual({
      at: 7,
      adapterWatts: 100,
      systemPowerInW: 68.51,
      systemLoadW: 68.74,
      batteryW: -0.22, // 2^64 wrap: BatteryPower=18446744073709551395 is -221 mW
      pct: 100,
    });
  });

  it("no adapter and no telemetry keys: nulls, still a reading", () => {
    expect(parseIoregPower('  |   "CurrentCapacity" = 41\n', 8)).toEqual({
      at: 8,
      adapterWatts: null,
      systemPowerInW: null,
      systemLoadW: null,
      batteryW: null,
      pct: 41,
    });
  });

  it("unrelated output is no reading", () => {
    expect(parseIoregPower("", 1)).toBeNull();
    expect(parseIoregPower("ioreg: no matching service", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Benchmark runs: exempt from pause, last-resort stop with time to save
// ---------------------------------------------------------------------------

describe("benchmark runs", () => {
  /** Feed readings through the normal machine, then the benchmark rules, as the tick does. */
  const feed = (readings: BatteryReading[]) => {
    let s = emptyBatteryState();
    let nv = evaluateBattery(s, readings[0], cfg);
    let bv = evaluateBenchmark(nv.state, readings[0], cfg);
    const out = { nv, bv, stops: 0, warns: 0, reasons: [] as string[] };
    s = bv.state;
    for (const x of readings.slice(1)) {
      nv = evaluateBattery(s, x, cfg);
      bv = evaluateBenchmark(nv.state, x, cfg);
      s = bv.state;
      out.nv = nv;
      out.bv = bv;
      if (bv.stop) {
        out.stops++;
        out.reasons.push(bv.reason as string);
      }
      if (bv.warn) out.warns++;
    }
    return out;
  };
  // a slow drain: 0.1 %/min never projects below the floor within 20 min
  const slow = (from: number, n: number): BatteryReading[] =>
    Array.from({ length: n }, (_, i) => r(i * 60_000, from - Math.floor(i / 10), "battery"));

  it("labels: strata-bench, night queue and bench/benchmark are benchmark; ordinary work is not", () => {
    for (const l of ["strata-bench q3", "night queue runner", "night-queue", "benchmark run 4", "bench"]) expect(isBenchmarkLabel(l)).toBe(true);
    for (const l of ["fix the gate", "benchwarmer", "", undefined]) expect(isBenchmarkLabel(l)).toBe(false);
  });

  it("exemption: at 24 % the normal machine pauses, a benchmark is only warned (once) and not stopped", () => {
    const o = feed(slow(30, 60)); // 30 % falling to 25 % over an hour
    expect(o.nv.state.phase).toBe("paused"); // normal local work is held ...
    expect(o.stops).toBe(0); // ... a benchmark is not stopped
    expect(o.warns).toBe(1);
    expect(o.bv.state.benchStopped).toBe(false);
  });

  it("benchmark stops at benchmarkStopBelowPct (15) in one move and stays latched", () => {
    expect(cfg.benchmarkStopBelowPct).toBe(15);
    const o = feed([r(0, 17, "battery"), r(60_000, 16, "battery"), r(120_000, 15, "battery"), r(180_000, 14, "battery")]);
    expect(o.stops).toBe(1);
    expect(o.reasons[0]).toContain("benchmarkStopBelowPct 15");
    expect(o.bv.state.benchStopped).toBe(true);
  });

  it("drain-rate early trigger: 1 %/min at 40 % projects 20 % in 20 min (no stop); at 29 % it projects 9 % and stops early", () => {
    const fall = (from: number, perMin: number) => Array.from({ length: 10 }, (_, i) => r(i * 60_000, from - i * perMin, "battery"));
    // ends at 31 %: 31 - 1*20 = 11 > 10 → no early stop
    expect(feed(fall(40, 1)).stops).toBe(0);
    // reaches 30 % on the ninth reading: 30 - 20 = 10 <= 10 → early stop, well above 15 %
    const o = feed(fall(38, 1));
    expect(o.stops).toBe(1);
    expect(o.reasons[0]).toContain("projects 10 %");
    expect(o.reasons[0]).toContain("1.00 %/min");
  });

  it("the latch clears only above benchmarkStopBelowPct + hysteresisPct", () => {
    let s = feed([r(0, 15, "battery")]).bv.state;
    expect(s.benchStopped).toBe(true);
    s = evaluateBenchmark(evaluateBattery(s, r(60_000, 25, "ac", "charging"), cfg).state, r(60_000, 25, "ac", "charging"), cfg).state;
    expect(s.benchStopped).toBe(true); // 25 = 15 + 10: not above
    s = evaluateBenchmark(evaluateBattery(s, r(120_000, 26, "ac", "charging"), cfg).state, r(120_000, 26, "ac", "charging"), cfg).state;
    expect(s.benchStopped).toBe(false);
  });

  it("drainRatePctPerMin: needs a window, ignores a rising battery", () => {
    expect(drainRatePctPerMin([r(0, 50, "battery"), r(60_000, 49, "battery")], 10)).toBeNull();
    expect(drainRatePctPerMin(Array.from({ length: 10 }, (_, i) => r(i * 60_000, 50 + i, "ac", "charging")), 10)).toBeNull();
  });
});

describe("benchmark stop pass and gate", () => {
  const bl = join(root, "bench-logs");
  const providers = { localA: { baseUrl: "http://127.0.0.1:11434" } };
  const mk = (id: string, label: string): void =>
    saveStatus(bl, {
      id,
      pid: process.pid,
      label,
      cwd: bl,
      term: "",
      provider: "localA",
      model: "m",
      state: "running",
      started: "2026-10-24 10:00:00",
      updated: "2026-10-24 10:00:00",
      turns: 1,
      tools: 0,
      last: "x",
      rc: null,
      secs: null,
      origin: "spawn",
      procStart: Date.now(),
    } as WorkerStatus);

  it("normal stop skips benchmark runs and keeps the runtime; benchmark stop takes only benchmark runs, waits the save window, then stops runtimes", async () => {
    mkdirSync(bl, { recursive: true });
    mk("ordinary", "fix the gate");
    mk("bench-1", "strata-bench item 7");
    expect(localKillTargets(bl, providers)).toEqual(["ordinary"]);
    expect(localKillTargets(bl, providers, true)).toEqual(["bench-1"]);

    const stopped: string[] = [];
    const common = { stopRuntime: async (n: string) => (stopped.push(n), { ok: true, message: `${n} stopped` }), runtimesToStop: () => ["ollama"], now: () => 1_760_000_000_000 };
    const killedA: string[] = [];
    await stopLocalWork(bl, providers, "battery at 11 %", { ...common, killWorker: async (_d, id) => (killedA.push(id), [`sent SIGTERM to ${id}`]) });
    expect(killedA).toEqual(["ordinary"]);
    expect(stopped).toEqual([]); // a live benchmark keeps its model

    const killedB: string[] = [];
    const lines = await stopLocalWork(bl, providers, "battery at 15 %", {
      ...common,
      saveMs: 120_000,
      facts: "pct=15 drainPctPerMin=0.80",
      killWorker: async (_d, id) => (killedB.push(id), [`sent SIGTERM to ${id}`]),
    });
    expect(killedB).toEqual(["bench-1"]);
    expect(stopped).toEqual(["ollama"]);
    expect(lines).toEqual(["sent SIGTERM to bench-1", "ollama: ollama stopped"]);
    const ledger = readFileSync(join(bl, "ledger.log"), "utf8");
    expect(ledger).toContain("BATTERY-BENCH-STOP reason=battery at 15 % facts=pct=15 drainPctPerMin=0.80");
  });

  it("the tick: a paused battery leaves benchmark admission open; the 15 % stop closes it, records telemetry, and stops once", async () => {
    const state = { current: emptyBatteryState() };
    let t = Date.now();
    let pct = 24;
    const benchStops: string[] = [];
    const tick = () =>
      batteryGuardTick(bl, { providers }, cfg, {
        read: async () => ({ at: t, pct, source: "battery", charge: "discharging" }),
        now: () => t,
        stop: async () => [],
        benchmarkLive: () => true,
        readPower: async (at) => ({ at, adapterWatts: null, systemPowerInW: 0, systemLoadW: 31.5, batteryW: -31.5, pct }),
        benchStop: async (_d, _p, why, saveMs, facts) => (benchStops.push(`${why}|${saveMs}|${facts}`), ["saved"]),
      }, state);
    await tick(); // 24 %: normal work paused, benchmark open
    expect(batteryGateRefusal(t)).toContain("battery at 24 %");
    expect(batteryGateRefusal(t, true)).toBeNull();
    expect(batteryGuardRefusal(true, bl, "localA", t, undefined, true)).toBeNull();

    t += 60_000;
    pct = 15;
    await tick();
    await tick(); // latched: no second stop
    expect(benchStops).toHaveLength(1);
    expect(benchStops[0]).toContain("benchmarkStopBelowPct 15)|120000|pct=15");
    expect(batteryGateRefusal(t, true)).toContain("benchmarkStopBelowPct 15");
    expect(batteryGuardRefusal(true, bl, "localA", t, undefined, true)).toContain("stopped benchmark runs");
    const tel = readFileSync(join(home, "battery-telemetry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(tel.length).toBe(3);
    expect(tel[1]).toMatchObject({ pct: 15, systemLoadW: 31.5, batteryW: -31.5 });
  });
});
