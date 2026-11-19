import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSocTempJson, recordSocTemp, resetSocTempState, socTempState } from "../workers/local-idle.js";
import { SystemMonitor } from "./system.js";

const FIXTURE = '{"socTempC":66.8,"socTempAvgC":63.8,"sensors":42}';

describe("pai-sensors JSON parse", () => {
  it("parses a good line", () => {
    const r = parseSocTempJson(FIXTURE + "\n");
    expect(r).not.toBeNull();
    expect(r!.maxC).toBe(66.8);
    expect(r!.avgC).toBe(63.8);
    expect(r!.sensors).toBe(42);
  });
  it("rejects malformed, null-valued and non-JSON output", () => {
    expect(parseSocTempJson('{"socTempC":null,"socTempAvgC":null,"sensors":0,"error":"client"}')).toBeNull();
    expect(parseSocTempJson("not json")).toBeNull();
    expect(parseSocTempJson("{\"socTempC\":\"66\"}")).toBeNull();
  });
});

describe("missing helper fallback", () => {
  it("records the failure reason once and keeps the last value on a later failed run", () => {
    resetSocTempState();
    recordSocTemp(1000, parseSocTempJson(FIXTURE));
    expect(socTempState().last?.maxC).toBe(66.8);
    expect(socTempState().error).toBe("");
    recordSocTemp(2000, null); // a failed run keeps the value and names why once
    expect(socTempState().last?.maxC).toBe(66.8);
    expect(socTempState().error).toContain("helper");
  });
  it("the tile feed shows the temperature from the daemon's state file, and '–' with a reason without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soc-"));
    const idleFile = (obj: object) => writeFileSync(join(dir, "local-idle.json"), JSON.stringify(obj));
    const now = Date.now();
    // helper reading present: socTemp/socTempAvg in the sample, no hint
    idleFile({ at: new Date(now).toISOString(), gpuPct: 10, providers: [], socTempC: 66.8, socTempAvgC: 63.8, socSensors: 42, socTempAt: now });
    const m = new SystemMonitor({ file: "/dev/null", telemetryFile: "/dev/null", workersLogDir: () => dir, now: () => now });
    const s1 = await m.current();
    expect(s1.sample?.socTemp).toBe(66.8);
    expect(s1.sample?.socTempAvg).toBe(63.8);
    const snap1 = await m.snapshot("1h");
    expect(snap1.hints?.["soc-temp"]).toBeUndefined();
    // helper failed: no value, the reason rides in the hint (the tile draws '–' + tooltip)
    resetSocTempState();
    recordSocTemp(now, null);
    idleFile({ at: new Date(now).toISOString(), gpuPct: 10, providers: [], socTempError: socTempState().error });
    const m2 = new SystemMonitor({ file: "/dev/null", telemetryFile: "/dev/null", workersLogDir: () => dir, now: () => now });
    const s2 = await m2.current();
    expect(s2.sample?.socTemp).toBeUndefined();
    const snap2 = await m2.snapshot("1h");
    expect(snap2.hints?.["soc-temp"]).toContain("helper");
  });
});
