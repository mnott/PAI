import { describe, expect, it } from "vitest";
import { relaunchOptions, type RunOptions } from "./run.js";

describe("relaunchOptions", () => {
  const orig: RunOptions = {
    claudeArgs: ["--x"],
    id: "w-1",
    maxMinutes: 15,
    deadline: "13:00",
    browser: false,
    quiet: true,
    modelFlag: "m",
    reportFormatFlag: "json",
    noReportRetry: true,
    providerFlag: "a",
  };

  it("keeps the original limit, browser, report and quiet options", () => {
    const r = relaunchOptions(orig, { providerFlag: "b", _emptyRetried: true });
    expect(r).toMatchObject({
      maxMinutes: 15,
      deadline: "13:00",
      browser: false,
      quiet: true,
      modelFlag: "m",
      reportFormatFlag: "json",
      noReportRetry: true,
      claudeArgs: ["--x"],
      providerFlag: "b",
      _emptyRetried: true,
    });
  });

  it("drops the preset id and applies explicit changes", () => {
    const r = relaunchOptions(orig, { modelFlag: undefined, _reroutes: 1 });
    expect(r.id).toBeUndefined();
    expect(r.modelFlag).toBeUndefined();
    expect(r._reroutes).toBe(1);
  });
});
