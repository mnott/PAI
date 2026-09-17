/**
 * Tests for the gutter / context meter / operator + report rendering (2g, 2h,
 * 2i, 2j). Pure functions; no claude, no osascript.
 */

import { describe, it, expect } from "vitest";
import {
  blankBetween,
  clockOf,
  contextMeter,
  dayOf,
  gutterFor,
  intentOf,
  makeColor,
  renderEvent,
  renderStatusLine,
  tickerText,
  tickerTool,
} from "./render.js";
import type { WorkerStatus } from "./status.js";

const plain = makeColor(false);
const color = makeColor(true);

describe("clockOf / dayOf", () => {
  it("renders at the given offset, whatever zone stamped the log", () => {
    // UTC stamp read at UTC+2 — the 12:19 → 14:19 case the pane got wrong
    expect(clockOf("2026-09-17T12:19:23Z", 120)).toBe("14:19:23");
    expect(dayOf("2026-09-17T12:19:23Z", 120)).toBe("2026-09-17");
  });

  it("keeps a local-offset stamp at its own wall clock when read at UTC", () => {
    expect(clockOf("2026-09-17T14:19:23+02:00", 0)).toBe("12:19:23");
  });

  it("crosses the day at the offset, not at UTC", () => {
    // 23:30 UTC is already the next day at UTC+2
    expect(dayOf("2026-09-17T23:30:00Z", 120)).toBe("2026-09-18");
    expect(clockOf("2026-09-17T23:30:00Z", 120)).toBe("01:30:00");
  });

  it("null for unparsable stamps", () => {
    expect(clockOf("not a date", 0)).toBeNull();
    expect(dayOf("", 0)).toBeNull();
  });
});

describe("gutterFor", () => {
  it("derives HH:MM:SS from the ISO stamp", () => {
    const g = gutterFor(plain, { _ts: "2026-09-17T14:03:09Z" }, undefined, 0)!;
    expect(g.first).toBe("14:03:09 │ ");
    expect(g.cont).toBe(" ".repeat(11));
  });

  it("renders local time from a local-offset stamp (no conversion needed)", () => {
    const g = gutterFor(plain, { _ts: "2026-09-17T14:03:09+02:00" }, undefined, 120)!;
    expect(g.first).toBe("14:03:09 │ ");
  });

  it("puts the worker tag in front when several run at once", () => {
    const g = gutterFor(color, { _ts: "2026-09-17T14:03:09Z" }, "ab12", 0)!;
    expect(g.first).toBe(`\x1b[2mab12 14:03:09 │ \x1b[0m`);
    expect(g.cont).toBe(" ".repeat(16));
  });

  it("barCont keeps the bar: blanks for the time, dim │ at the same column", () => {
    const g = gutterFor(color, { _ts: "2026-09-17T14:03:09Z" }, undefined, 0)!;
    expect(g.barCont).toBe(`\x1b[2m${" ".repeat(8)} │ \x1b[0m`);
    expect(g.width).toBe(11);
    const t = gutterFor(plain, { _ts: "2026-09-17T14:03:09Z" }, "ab12", 0)!;
    expect(t.barCont).toBe(" ".repeat(13) + " │ ");
    expect(t.width).toBe(16);
  });

  it("is null for unstamped (pre-2g) events", () => {
    expect(gutterFor(plain, {})).toBeNull();
  });
});

describe("tickerTool", () => {
  it("shows the command for Bash, whitespace collapsed, capped at 60", () => {
    expect(tickerTool("Bash", { command: "bun run test" })).toBe("$ bun run test");
    expect(tickerTool("Bash", { command: "cd   /tmp\n&&   make" })).toBe("$ cd /tmp && make");
    const long = "x".repeat(80);
    expect(tickerTool("Bash", { command: long })).toBe(`$ ${"x".repeat(59)}…`);
  });

  it("shows the file basename for the file tools", () => {
    expect(tickerTool("Read", { file_path: "/repo/src/workers/viewer.ts" })).toBe("viewer.ts");
    expect(tickerTool("Edit", { file_path: "/repo/src/x.ts" })).toBe("x.ts");
    expect(tickerTool("Write", { file_path: "/repo/out.md" })).toBe("out.md");
  });

  it("falls back to the bare tool name", () => {
    expect(tickerTool("WebSearch", { query: "vitest" })).toBe("WebSearch");
    expect(tickerTool("Read", {})).toBe("Read");
  });
});

describe("tickerText", () => {
  it("composes seconds, intent and tool", () => {
    expect(tickerText(12, "run tests before the fix", "$ bun run test")).toBe(
      "⋯ 12s · run tests before the fix · $ bun run test"
    );
  });

  it("drops empty parts and the meter when absent", () => {
    expect(tickerText(3, "", "$ make")).toBe("⋯ 3s · $ make");
    expect(tickerText(3, "  ", "")).toBe("⋯ 3s");
  });

  it("appends the context meter when present", () => {
    expect(tickerText(5, "intent", "$ cmd", "ctx 84k/200k (42%)")).toBe(
      "⋯ 5s · intent · $ cmd · ctx 84k/200k (42%)"
    );
  });
});

describe("blankBetween", () => {
  it("one blank before an assistant message that follows a tool result or operator text", () => {
    expect(blankBetween({ type: "user" }, { type: "assistant" })).toBe(true);
    expect(blankBetween({ type: "operator" }, { type: "assistant" })).toBe(true);
  });

  it("no blank inside a turn or before other event kinds", () => {
    expect(blankBetween({ type: "assistant" }, { type: "assistant" })).toBe(false);
    expect(blankBetween({ type: "assistant" }, { type: "user" })).toBe(false);
    expect(blankBetween(null, { type: "assistant" })).toBe(false);
  });
});

describe("intentOf", () => {
  it("takes the first non-empty line, whitespace-collapsed, capped at 60", () => {
    expect(intentOf("run tests\nbefore the fix")).toBe("run tests");
    expect(intentOf("\n\n  run   tests  now\nrest")).toBe("run tests now");
    expect(intentOf("y".repeat(80))).toBe(`${"y".repeat(59)}…`);
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
    const g = gutterFor(plain, { _ts: "2026-09-17T14:03:09Z" }, undefined, 0)!;
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
