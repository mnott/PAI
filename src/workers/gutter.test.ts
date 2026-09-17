/**
 * Tests for the gutter / context meter / operator + report rendering (2g, 2h,
 * 2i, 2j). Pure functions; no claude, no osascript.
 */

import { describe, it, expect } from "vitest";
import {
  blankBetween,
  chatStatusRow,
  clockOf,
  contextMeter,
  dayOf,
  fmtElapsed,
  gutterFor,
  intentOf,
  makeColor,
  renderEvent,
  renderStatusLine,
  tickerText,
  tickerTool,
} from "./render.js";
import { agentLabel } from "./agents.js";
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

describe("chatStatusRow", () => {
  const running = {
    provider: "glm",
    model: "glm-5.3",
    contextTokens: 84000,
    contextWindow: 200000,
    turns: 12,
    tools: 7,
    elapsed: 252,
    idle: 7,
    intent: "count the .ts files",
    tool: "$ find src -name '*.ts'",
  };

  it("composes the running row: provider/model, ctx, turns, tools, runtime, ticker", () => {
    expect(chatStatusRow(plain, running)).toBe(
      "[glm/glm-5.3] ctx 84k/200k (42%) · turns 12 · tools 7 · 4m12s · ⋯ 7s · count the .ts files · $ find src -name '*.ts'"
    );
  });

  it("renders exactly the label the statusline meter renders (one shared format)", () => {
    expect(chatStatusRow(plain, running)).toContain(contextMeter(plain, running) ?? "");
    expect(chatStatusRow(color, { ...running, contextTokens: 150000 })).toContain(
      contextMeter(color, { ...running, contextTokens: 150000 }) ?? ""
    );
  });

  it("drops the ctx part when the numbers are missing, and empty intent/tool", () => {
    expect(chatStatusRow(plain, { ...running, contextTokens: null, intent: "", tool: "" })).toBe(
      "[glm/glm-5.3] turns 12 · tools 7 · 4m12s · ⋯ 7s"
    );
  });

  it("colours the ctx part yellow past 70 and red past 85 percent", () => {
    expect(chatStatusRow(color, { ...running, contextTokens: 150000 })).toContain(
      "\x1b[33mctx 150k/200k (75%)\x1b[0m"
    );
    expect(chatStatusRow(color, { ...running, contextTokens: 180000 })).toContain(
      "\x1b[31mctx 180k/200k (90%)\x1b[0m"
    );
  });

  it("a finished row freezes the numbers and shows ✓/✗ instead of the ticker part", () => {
    expect(chatStatusRow(plain, { ...running, state: "done", elapsed: 260 })).toBe(
      "[glm/glm-5.3] ctx 84k/200k (42%) · turns 12 · tools 7 · 4m20s · ✓ done"
    );
    const failed = chatStatusRow(color, { ...running, state: "failed" });
    expect(failed).not.toContain("⋯");
    expect(failed).not.toContain("count the .ts files");
    expect(failed).toContain("\x1b[31m✗ failed\x1b[0m");
  });

  it("fmtElapsed renders m+s with zero-padded seconds", () => {
    expect(fmtElapsed(252)).toBe("4m12s");
    expect(fmtElapsed(65)).toBe("1m05s");
    expect(fmtElapsed(8)).toBe("0m08s");
  });
});

describe("renderEvent", () => {
  const tools: Record<string, string> = {};

  it("operator messages render with the » marker", () => {
    expect(renderEvent(plain, "", { type: "operator", text: "run the tests" }, "", tools)).toEqual([
      "» run the tests",
    ]);
  });

  it("a handoff delivery's operator mirror renders nothing — the ◆ inbox line is the copy", () => {
    expect(
      renderEvent(plain, "", { type: "operator", text: "[handoff from c1] (result) done", handoff: true }, "", tools)
    ).toEqual([]);
    const g = gutterFor(plain, { _ts: "2026-09-17T14:03:09Z" }, undefined, 0)!;
    expect(
      renderEvent(plain, "", { type: "operator", text: "[handoff from c1] (result) done", handoff: true }, "", tools, g)
    ).toEqual([]);
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

describe("renderStatusLine", () => {
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
  const chat: WorkerStatus = {
    ...base,
    id: "20260917-100000-3390",
    state: "running",
    origin: "chat",
    provider: "glm",
    label: "unlabeled",
    turns: 0,
    last: "interactive",
  };
  const spawn = (over: Partial<WorkerStatus>): WorkerStatus => ({
    ...base,
    state: "running",
    origin: "spawn",
    provider: "glm",
    ...over,
  });

  it("agentLabel falls back to the unlabeled placeholder without a prompt", () => {
    expect(agentLabel("Explore", null)).toBe("Explore: unlabeled");
    expect(agentLabel("Explore", "fix the thing")).toContain("fix the thing");
  });

  it("chat pane alone: the provider and nothing else — no count, age, state, inbox", () => {
    expect(renderStatusLine([chat], now)).toBe("glm");
  });

  it("one worker: provider ▶N and the row name · age · step", () => {
    const w = spawn({ id: "20260917-100000-4969", label: "fix black buttons" });
    expect(renderStatusLine([chat, w], now)).toBe("glm ▶1 | fix black buttons · 45s · npm …");
  });

  it("N workers: ▶N, rows ordered oldest first, no #id on distinct labels", () => {
    const older = spawn({ id: "20260917-100000-4969", label: "fix black buttons", started: "2026-09-17 09:30:00" });
    const young = spawn({ id: "20260917-100000-2924", label: "spotcheck login" });
    const out = renderStatusLine([chat, young, older], now);
    expect(out).toBe("glm ▶2 | fix black buttons · 30m · npm … | spotcheck login · 45s · npm …");
  });

  it("counts only running workers with a live pid in ▶N", () => {
    const live = spawn({ id: "20260917-100000-1237" });
    const dead = spawn({ id: "20260917-100000-1238", pid: 999999 });
    const out = renderStatusLine([chat, live, dead], now);
    expect(out).toContain("▶1");
    expect(out).not.toContain("1238");
  });

  it("a dead chat pane's workers render under the provider fallback", () => {
    const stale: WorkerStatus = { ...chat, pid: 999999 };
    const w = spawn({ id: "20260917-100000-4969", label: "fix black buttons" });
    const out = renderStatusLine([stale, w], now);
    expect(out).toBe("glm ▶1 | fix black buttons · 45s · npm …");
    expect(out).not.toContain("interactive");
  });

  it("legacy pane entry (no origin, unlabeled placeholder, 0 turns) is neither row nor count", () => {
    const legacy: WorkerStatus = { ...chat, id: "20260917-091645-7777", started: "2026-09-17 09:16:45", label: "(no prompt)", origin: undefined };
    const w = spawn({ id: "20260917-100000-4969", label: "fix black buttons" });
    const out = renderStatusLine([legacy, w], now);
    expect(out).toBe("glm ▶1 | fix black buttons · 45s · npm …");
    const legacy2: WorkerStatus = { ...legacy, label: "unlabeled" };
    expect(renderStatusLine([legacy2, w], now)).toBe("glm ▶1 | fix black buttons · 45s · npm …");
  });

  it("rows are flat: a sub-worker renders without ↳ indent", () => {
    const w1 = spawn({ id: "20260917-100000-4969", label: "fix black buttons", parent: chat.id });
    const w2 = spawn({ id: "20260917-100000-2924", label: "spotcheck login", parent: w1.id });
    const out = renderStatusLine([chat, w1, w2], now);
    expect(out).toContain("| fix black buttons · 45s · npm … | spotcheck login · 45s · npm …");
    expect(out).not.toContain("↳");
  });

  it("twins share a label: both rows carry #id; unique labels carry none", () => {
    const a = spawn({ id: "20260917-100000-1111", label: "build site" });
    const b = spawn({ id: "20260917-100000-2222", label: "build site" });
    const out = renderStatusLine([chat, a, b], now);
    expect(out).toContain("#1111 build site · 45s · npm …");
    expect(out).toContain("#2222 build site · 45s · npm …");
    const c = spawn({ id: "20260917-100000-3333", label: "unique label" });
    expect(renderStatusLine([chat, a, c], now)).not.toContain("#3333");
  });

  it("step trims the Bash command to its verb, no prefix, flags or quotes", () => {
    const w = (last: string) => spawn({ id: "20260917-100000-4969", label: "fix black buttons", last });
    expect(renderStatusLine([chat, w('Bash: grep -n -A4 "x" src/')], now)).toContain("grep …");
    expect(renderStatusLine([chat, w("Bash: ls")], now)).toContain("45s · ls");
    expect(renderStatusLine([chat, w("Read: render.ts")], now)).toContain("Read: render.ts");
    expect(renderStatusLine([chat, w("x".repeat(60))], now)).toContain(`${"x".repeat(23)}…`);
  });

  it("the bar carries no context meter or inbox mark — ps and the pane do", () => {
    const w = spawn({ id: "20260917-100000-1234", label: "fix black buttons", contextTokens: 150000, contextWindow: 200000 });
    expect(renderStatusLine([chat, w], now)).not.toContain("ctx ");
    expect(renderStatusLine([chat, w], now)).not.toContain("◆");
  });

  it("today's tail stays: ✓N ✗M today", () => {
    const done = spawn({ id: "20260917-100000-5555", label: "done earlier", state: "done", rc: 0, secs: 12 });
    const failed = spawn({ id: "20260917-100000-5556", label: "failed earlier", state: "failed", rc: 1, secs: 5 });
    const out = renderStatusLine([chat, done, failed], now);
    expect(out).toBe("glm   ✓1 ✗1 today");
  });
});
