/** Setup AIBroker step with an injected command runner: nothing is installed for real. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepAibroker, type CmdRunner } from "./steps/18-aibroker.js";
import { stepSummary } from "./steps/15-verify.js";

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

function runner(failOn?: string) {
  const calls: string[] = [];
  const fn: CmdRunner = (cmd, args) => {
    const s = [cmd, ...args].join(" ");
    calls.push(s);
    return { status: s === failOn ? 1 : 0, output: s === failOn ? "boom" : "" };
  };
  return { fn, calls };
}

describe("stepAibroker", () => {
  it("present and doctor ok: no install", () => {
    const r = runner();
    expect(stepAibroker(r.fn, {})).toBe("ok");
    expect(r.calls).toEqual(["aibroker doctor"]);
  });

  it("missing: install, setup, doctor in order, no prompt", () => {
    const r = runner("aibroker doctor");
    // first doctor fails (missing), later doctor must succeed
    let n = 0;
    const fn: CmdRunner = (cmd, args) => {
      const s = [cmd, ...args].join(" ");
      r.calls.push(s);
      return s === "aibroker doctor" && n++ === 0 ? { status: 127, output: "not found" } : { status: 0, output: "" };
    };
    r.calls.length = 0;
    expect(stepAibroker(fn, {})).toBe("installed");
    expect(r.calls).toEqual(["aibroker doctor", "npm install -g aibroker", "aibroker setup", "aibroker doctor"]);
  });

  it("install fails: failed, output and retry command shown, later commands not run", () => {
    const calls: string[] = [];
    const fn: CmdRunner = (cmd, args) => {
      const s = [cmd, ...args].join(" ");
      calls.push(s);
      return s === "npm install -g aibroker" ? { status: 1, output: "EACCES" } : { status: 1, output: "" };
    };
    expect(stepAibroker(fn, {})).toBe("failed");
    expect(calls).toEqual(["aibroker doctor", "npm install -g aibroker"]);
    const text = out.join("\n");
    expect(text).toContain("EACCES");
    expect(text).toContain("Retry with: npm install -g aibroker && aibroker setup && aibroker doctor");
  });

  it("--no-aibroker: skipped, nothing run", () => {
    const r = runner();
    expect(stepAibroker(r.fn, { skip: true })).toBe("skipped");
    expect(r.calls).toEqual([]);
  });

  it("--dry-run: prints the three commands, runs nothing", () => {
    const r = runner();
    stepAibroker(r.fn, { dryRun: true });
    expect(r.calls).toEqual([]);
    const text = out.join("\n");
    for (const s of ["npm install -g aibroker", "aibroker setup", "aibroker doctor"]) expect(text).toContain(s);
  });

  it("summary lists a failed step", () => {
    stepSummary({}, false, false, false, false, false, false, false, "PAI", false, false, "linux", "failed");
    expect(out.find((l) => l.includes("AIBroker:"))).toContain("FAILED");
  });
});
