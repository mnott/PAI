/**
 * Tests for the gutter / context meter / operator + report rendering (2g, 2h,
 * 2i, 2j). Pure functions; no claude, no osascript.
 */

import { describe, it, expect } from "vitest";
import { makeColor, gutterFor, contextMeter, renderEvent, renderStatusLine } from "./render.js";
import type { WorkerStatus } from "./status.js";

const plain = makeColor(false);
const color = makeColor(true);

describe("gutterFor", () => {
  it("derives HH:MM:SS from the ISO stamp", () => {
    const g = gutterFor(plain, { _ts: "2026-09-17T14:03:09Z" })!;
    expect(g.first).toBe("14:03:09 │ ");
    expect(g.cont).toBe(" ".repeat(11));
  });

  it("puts the worker tag in front when several run at once", () => {
    const g = gutterFor(color, { _ts: "2026-09-17T14:03:09Z" }, "ab12")!;
    expect(g.first).toBe(`\x1b[2mab12 14:03:09 │ \x1b[0m`);
    expect(g.cont).toBe(" ".repeat(16));
  });

  it("is null for unstamped (pre-2g) events", () => {
    expect(gutterFor(plain, {})).toBeNull();
  });
});

describe("contextMeter", () => {
  it("formats ctx tokens/window/percent", () => {
    expect(contextMeter(plain, { contextTokens: 84000, contextWindow: 200000 })).toBe(
      "ctx 84k/200k (42%)"
    );
  });

  it("plain under 70, yellow above 70, red above 85", () => {
    expect(contextMeter(plain, { contextTokens: 100000, contextWindow: 200000 })).toBe(
      "ctx 100k/200k (50%)"
    );
    expect(contextMeter(color, { contextTokens: 150000, contextWindow: 200000 })).toBe(
      `\x1b[33mctx 150k/200k (75%)\x1b[0m`
    );
    expect(contextMeter(color, { contextTokens: 180000, contextWindow: 200000 })).toBe(
      `\x1b[31mctx 180k/200k (90%)\x1b[0m`
    );
  });

  it("hides below the minimum percent and when numbers are missing", () => {
    expect(contextMeter(plain, { contextTokens: 50000, contextWindow: 200000 }, 60)).toBeNull();
    expect(contextMeter(plain, {}, 0)).toBeNull();
    expect(contextMeter(plain, { contextTokens: 1000, contextWindow: 0 })).toBeNull();
  });

  it("keeps small counts unscaled", () => {
    expect(contextMeter(plain, { contextTokens: 900, contextWindow: 1000 })).toBe("ctx 900/1k (90%)");
  });
});

describe("renderEvent", () => {
  const tools: Record<string, string> = {};

  it("operator messages render with the » marker", () => {
    expect(renderEvent(plain, "", { type: "operator", text: "run the tests" }, "", tools)).toEqual([
      "» run the tests",
    ]);
  });

  it("a contract final message renders as the report block", () => {
    const report = JSON.stringify({
      changed: [{ path: "src/x.ts", summary: "fix" }],
      checks: [{ name: "tests", ok: true, detail: "3 passed" }],
      notes: "done",
    });
    const out = renderEvent(plain, "", { type: "result", result: report, is_error: false, num_turns: 2, duration_ms: 5000 }, "", tools);
    expect(out[0]).toContain("✓ done · 2 turns · 5s");
    expect(out.join("\n")).toContain("src/x.ts — fix");
    expect(out.join("\n")).toContain("✓ tests");
    expect(out.join("\n")).toContain("done");
  });

  it("a non-contract final message stays raw", () => {
    const out = renderEvent(plain, "", { type: "result", result: "just prose", is_error: false, num_turns: 1, duration_ms: 1000 }, "", tools);
    expect(out.join("\n")).toContain("just prose");
    expect(out.join("\n")).not.toContain("notes");
  });

  it("continuation lines are padded to the gutter width", () => {
    const g = gutterFor(plain, { _ts: "2026-09-17T14:03:09Z" })!;
    const out = renderEvent(plain, "", { type: "operator", text: "one\ntwo" }, "", tools, g);
    expect(out).toEqual(["14:03:09 │ » one", " ".repeat(11) + "» two"]);
  });

  it("unstamped events render exactly as before (no gutter arg)", () => {
    expect(renderEvent(plain, "  ", { type: "operator", text: "hi" }, "", tools)).toEqual(["  » hi"]);
  });
});

describe("renderStatusLine meter", () => {
  const base = {
    pid: process.pid,
    label: "task",
    cwd: "/repo",
    term: "",
    provider: "prov",
    model: "m",
    started: "2026-09-17 10:00:00",
    updated: "2026-09-17 10:00:30",
    turns: 1,
    tools: 1,
    last: "Bash: npm test",
    rc: null,
    secs: null,
  } as WorkerStatus;
  const now = new Date("2026-09-17T10:00:45");

  it("shows the meter once context passes 60%", () => {
    const s: WorkerStatus = { ...base, id: "20260917-100000-1234", state: "running", contextTokens: 150000, contextWindow: 200000 };
    expect(renderStatusLine([s], now, plain)).toContain("ctx 150k/200k (75%)");
  });

  it("hides the meter below 60%", () => {
    const s: WorkerStatus = { ...base, id: "20260917-100000-1235", state: "running", contextTokens: 20000, contextWindow: 200000 };
    expect(renderStatusLine([s], now, plain)).not.toContain("ctx ");
  });
});
