import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The keep-above gate, calibration and the scheduler hold (src/daemon/battery-gate.ts,
 * src/workers/run/gate.ts) on an injected battery reader: a fake percent sequence.
 */

const root = mkdtempSync(join(tmpdir(), "pai-batterygate-"));
process.env.PAI_HOME = join(root, "home");
process.env.PAI_CONFIG_FILE = join(root, "config.yaml");

const { batteryGuardConfig } = await import("./battery-guard.js");
const { calibrate, CalibrateRefused, gateThresholds, powerStatus, readPowerConfig, saveCalibration, waitForBattery } = await import("./battery-gate.js");
const { keepAboveHold } = await import("../workers/run/gate.js");

const reading = (pct: number, source: "ac" | "battery" = "ac") => ({ at: 0, pct, source, charge: "charging" as const });

function fake(pcts: number[]) {
  const lines: string[] = [];
  let i = 0;
  let slept = 0;
  return {
    lines,
    slept: () => slept,
    deps: {
      read: async () => reading(pcts[Math.min(i++, pcts.length - 1)]),
      sleep: async (ms: number) => void (slept += ms),
      out: (l: string) => void lines.push(l),
    },
  };
}

describe("keep-above gate", () => {
  it("config: off by default, resume defaults to keep + 5", () => {
    expect(batteryGuardConfig({}).keepAbovePct).toBeNull();
    expect(gateThresholds(batteryGuardConfig({}))).toBeNull();
    const c = batteryGuardConfig({ batteryGuard: { keepAbovePct: 40 } });
    expect(gateThresholds(c)).toEqual({ keep: 40, resume: 45 });
    expect(gateThresholds(c, 30, 50)).toEqual({ keep: 30, resume: 50 });
  });

  it("passes at once at or above keepAbove", async () => {
    const f = fake([40]);
    const r = await waitForBattery({ keep: 40, resume: 45 }, null, f.deps);
    expect(r).toEqual({ ok: true, pauses: 0 });
    expect(f.lines).toEqual([]);
  });

  it("pauses below keepAbove in 10-min steps and resumes at resume", async () => {
    const f = fake([38, 41, 44, 45]);
    const r = await waitForBattery({ keep: 40, resume: 45 }, null, f.deps);
    expect(r).toEqual({ ok: true, pauses: 3 });
    expect(f.lines).toHaveLength(3);
    expect(f.lines[0]).toContain("38 %");
    expect(f.slept()).toBe(3 * 10 * 60_000);
  });

  it("names the estimate from the stored idle rate", async () => {
    const f = fake([30, 45]);
    await waitForBattery({ keep: 40, resume: 45 }, { idlePctPerHour: 60, loadPctPerHour: null, measuredAt: "x" }, f.deps);
    expect(f.lines[0]).toContain("about 15 min");
  });

  it("holds a new local worker below keepAbove, never a cloud one", async () => {
    const f = fake([35, 46]);
    const t = { keep: 40, resume: 45 };
    expect(await keepAboveHold(false, root, "cloud", { thresholds: t, gate: f.deps })).toBe(0);
    expect(f.lines).toEqual([]);
    expect(await keepAboveHold(true, root, "local", { thresholds: t, gate: f.deps })).toBe(1);
    expect(f.lines).toHaveLength(1);
    expect(await keepAboveHold(true, root, "local", { thresholds: null, gate: f.deps })).toBe(0);
  });
});

describe("calibration", () => {
  it("computes %/h from before/after", async () => {
    const f = fake([50, 60]);
    const r = await calibrate({ minutes: 10, load: false }, f.deps, () => null);
    expect(r).toMatchObject({ mode: "idle", from: 50, to: 60, pctPerHour: 60 });
    expect(f.slept()).toBe(10 * 60_000);
    const l = await calibrate({ minutes: 15, load: true }, fake([80, 76]).deps, () => "busy");
    expect(l).toMatchObject({ mode: "load", pctPerHour: -16 });
  });

  it("refuses idle calibration while a local job runs", async () => {
    await expect(calibrate({ minutes: 1, load: false }, fake([50, 51]).deps, () => "1 worker running on a local provider")).rejects.toThrow(CalibrateRefused);
  });

  it("stores the result through the config writer and keeps the other mode", async () => {
    const path = join(root, "calib", "config.yaml");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "calib"));
    writeFileSync(path, "# keep me\npower:\n  batteryGuard:\n    keepAbovePct: 40\n");
    process.env.PAI_CONFIG_FILE = path;
    saveCalibration("idle", 60, new Date("2026-10-26T00:00:00Z"), path);
    const cal = saveCalibration("load", -16, new Date("2026-10-26T01:00:00Z"), path);
    expect(cal).toEqual({ idlePctPerHour: 60, loadPctPerHour: -16, measuredAt: "2026-10-26T01:00:00.000Z" });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("keepAbovePct: 40");
    const back = readPowerConfig(path);
    expect(back.calibration).toEqual(cal);
    const st = await powerStatus({ read: async () => reading(30) }, path);
    expect(st.thresholds).toEqual({ keep: 40, resume: 45 });
    expect(st.minutesToResume).toBe(15);
  });
});
