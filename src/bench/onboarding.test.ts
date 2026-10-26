import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firingsPath, recordFiring, type Firing } from "../hooks/ts/lib/antipattern-log.js";
import { resetAntipatternCache } from "../hooks/ts/lib/antipatterns.js";
import { onboardingForRun, onboardingSummary, percentile, renderOnboarding, resolveModel } from "./onboarding.js";

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-onb-"));
  prevHome = process.env.PAI_HOME;
  process.env.PAI_HOME = home;
  resetAntipatternCache();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  resetAntipatternCache();
});

const firing = (id: string, model: string, workerId: string, ts: string): Firing => ({
  ts, id, version: 1, category: "tool-loop", action: "stop", mode: "enforce", provider: "gyro-m", model, workerId,
  project: "p", inputHash: "h", excerpt: "e", disposition: "undetermined",
});

describe("onboarding summary", () => {
  it("percentile is the ceil-rank over the sorted counts", () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([3, 3, 3], 90)).toBe(3);
    expect(percentile([11], 90)).toBe(11);
  });
  it("a fixture firings file: counts per pattern for the model in the window, suggestions at >= 5", () => {
    const t = (n: number) => new Date(Date.parse("2026-10-26T10:00:00Z") + n * 1000).toISOString();
    const fixture: Firing[] = [
      // identical-write: 11 firings over 3 runs of gyro-m (4, 4, 3) -> p90 4, shipped stop_at 20 -> suggestion 20
      ...[1, 2, 3, 4].map((i) => firing("identical-write", "qwen3.8-flash-next-gyro-m", "w-1", t(i))),
      ...[5, 6, 7, 8].map((i) => firing("identical-write", "qwen3.8-flash-next-gyro-m", "w-2", t(i))),
      ...[9, 10, 11].map((i) => firing("identical-write", "qwen3.8-flash-next-gyro-m", "w-3", t(i))),
      // growing-command: 5 firings in one run -> suggestion with max_repeats at p90 5 (shipped 4)
      ...[12, 13, 14, 15, 16].map((i) => firing("growing-command", "qwen3.8-flash-next-gyro-m", "w-1", t(i))),
      // revert: 4 firings -> below the threshold, listed but no suggestion
      ...[17, 18, 19, 20].map((i) => firing("revert", "qwen3.8-flash-next-gyro-m", "w-1", t(i))),
      // another model's firings are not this run's summary
      firing("identical-write", "other-model", "w-9", t(21)),
    ];
    const o = onboardingSummary(fixture, "qwen3.8-flash-next-gyro-m");
    expect(o.rows.map((r) => [r.id, r.count, r.layer])).toEqual([
      ["growing-command", 5, "behaviour"],
      ["identical-write", 11, "behaviour"],
      ["revert", 4, "behaviour"],
    ]);
    expect(o.suggestions).toEqual([
      "pai antipatterns set growing-command max_repeats 5 --model qwen3.8-flash-next-gyro-m --reason 'bench: 5 firings, p90 per run 5'",
      "pai antipatterns set identical-write stop_at 20 --model qwen3.8-flash-next-gyro-m --reason 'bench: 11 firings, p90 per run 4'",
    ]);
    // a shell-category firing is baseline: listed, never suggested
    const withShell = [...fixture, { ...firing("git-reset-hard", "qwen3.8-flash-next-gyro-m", "w-1", t(22)), category: "shell" }];
    const o2 = onboardingSummary(withShell, "qwen3.8-flash-next-gyro-m");
    expect(o2.rows.find((r) => r.id === "git-reset-hard")).toMatchObject({ layer: "baseline", suggest: false });
    expect(o2.suggestions).toEqual(o.suggestions);
  });
  it("resolveModel takes the provider's model from the window; renderOnboarding prints rows and suggestions", () => {
    const f = [firing("revert", "qwen3.8-flash-next-gyro-m", "w-1", "2026-10-26T10:00:00.000Z"), firing("revert", "session", "w-2", "2026-10-26T10:00:01.000Z")];
    expect(resolveModel(f, "gyro-m")).toBe("qwen3.8-flash-next-gyro-m");
    expect(resolveModel([], "gyro-m")).toBe("gyro-m");
    const lines = renderOnboarding(onboardingSummary(f, "qwen3.8-flash-next-gyro-m"));
    expect(lines[0]).toBe("rule summary for qwen3.8-flash-next-gyro-m (this run):");
    expect(lines[1]).toBe("  revert (behaviour): 1 firing");
    expect(lines).toContain("no suggestions (no behaviour pattern fired 5 or more times)");
    expect(renderOnboarding(onboardingSummary([], "m"))).toContain("  no firings recorded for this model");
  });
  it("onboardingForRun reads the live firing log filtered by model and time window", () => {
    recordFiring({ id: "revert", category: "tool-loop", action: "stop", mode: "enforce", input: "x", env: { PAI_WORKER_ID: "w-1", PAI_WORKER_MODEL: "gyro-x", PAI_WORKER_PROVIDER: "gyro" } });
    recordFiring({ id: "revert", category: "tool-loop", action: "stop", mode: "enforce", input: "x", env: { PAI_WORKER_ID: "w-2", PAI_WORKER_MODEL: "other", PAI_WORKER_PROVIDER: "gyro" } });
    const start = Date.now() - 1000;
    const o = onboardingForRun("gyro", start);
    expect(o.model).toBe("gyro-x");
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]).toMatchObject({ id: "revert", count: 1 });
    // a window that starts after the firings sees nothing
    expect(onboardingForRun("gyro", Date.now() + 60_000).rows).toHaveLength(0);
    expect(firingsPath()).toBeTruthy();
  });
});
