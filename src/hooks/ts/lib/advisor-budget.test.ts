import { describe, it, expect } from "vitest";
import {
  ADVISOR_MAX_AGE_SECONDS,
  freshBudgetPercent,
  normaliseMode,
  resolveAdvisorMode,
} from "./advisor-budget.js";

const NOW = 1_790_000_000;

describe("freshBudgetPercent", () => {
  it("returns the percentage while the reading is current", () => {
    expect(freshBudgetPercent({ weeklyBudgetPercent: 2, asOf: NOW - 30 }, NOW)).toBe(2);
  });

  it("keeps a zero percentage — 0% used is a reading, not a missing one", () => {
    expect(freshBudgetPercent({ weeklyBudgetPercent: 0, asOf: NOW }, NOW)).toBe(0);
  });

  it("drops a reading older than the max age", () => {
    const stale = { weeklyBudgetPercent: 97, asOf: NOW - ADVISOR_MAX_AGE_SECONDS - 1 };
    expect(freshBudgetPercent(stale, NOW)).toBeUndefined();
  });

  it("drops a reading with no asOf at all", () => {
    // This is the shape the old statusline wrote. It is indistinguishable from
    // one that stopped being updated, so it cannot be trusted.
    expect(freshBudgetPercent({ weeklyBudgetPercent: 97, mode: "auto" }, NOW)).toBeUndefined();
  });
});

describe("normaliseMode", () => {
  it("accepts the five real modes", () => {
    for (const m of ["normal", "conservative", "strict", "critical", "auto"]) {
      expect(normaliseMode(m)).toBe(m);
    }
  });

  it("treats the empty string as auto", () => {
    // {"mode": ""} is what the statusline used to write with no manual
    // override; `?? "auto"` did not catch it and the advisor went silent.
    expect(normaliseMode("")).toBe("auto");
  });

  it("treats anything unrecognised as auto", () => {
    expect(normaliseMode(undefined)).toBe("auto");
    expect(normaliseMode(7)).toBe("auto");
    expect(normaliseMode("panic")).toBe("auto");
  });
});

describe("resolveAdvisorMode", () => {
  it.each([
    [0, "normal"],
    [2, "normal"],
    [59, "normal"],
    [60, "conservative"],
    [79, "conservative"],
    [80, "strict"],
    [91, "strict"],
    [92, "critical"],
    [100, "critical"],
  ])("maps %i%% used to %s", (percent, expected) => {
    const got = resolveAdvisorMode({ weeklyBudgetPercent: percent, asOf: NOW }, NOW);
    expect(got.mode).toBe(expected);
    expect(got.percent).toBe(percent);
  });

  it("reads the percentage as USED, not as remaining", () => {
    // The whole fault this module exists for: 2% used is a nearly untouched
    // budget and must read "normal". If anything ever flips the sense, 2 lands
    // on 98 and this test fails rather than a session being told to stop
    // working. Both ends are pinned so an inversion cannot pass.
    expect(resolveAdvisorMode({ weeklyBudgetPercent: 2, asOf: NOW }, NOW).mode).toBe("normal");
    expect(resolveAdvisorMode({ weeklyBudgetPercent: 98, asOf: NOW }, NOW).mode).toBe("critical");
  });

  it("says nothing at all when the reading is stale", () => {
    const stale = { weeklyBudgetPercent: 97, asOf: NOW - ADVISOR_MAX_AGE_SECONDS - 1 };
    expect(resolveAdvisorMode(stale, NOW)).toEqual({ mode: undefined, percent: undefined });
  });

  it("says nothing at all when there is no reading", () => {
    expect(resolveAdvisorMode({}, NOW)).toEqual({ mode: undefined, percent: undefined });
  });

  it("honours a manual mode even with no usable percentage", () => {
    const got = resolveAdvisorMode({ mode: "strict" }, NOW);
    expect(got.mode).toBe("strict");
    expect(got.percent).toBeUndefined();
  });

  it("lets a manual mode override a current reading", () => {
    const got = resolveAdvisorMode({ mode: "critical", weeklyBudgetPercent: 2, asOf: NOW }, NOW);
    expect(got.mode).toBe("critical");
    expect(got.percent).toBe(2);
  });
});
