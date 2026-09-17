/**
 * Tests for the run helpers: stream-json stdin framing (2i), the context
 * metering fields (2j) and the runner's argument tail parsing (2i/2j). Pure
 * functions — no claude, no osascript.
 */

import { describe, it, expect } from "vitest";
import { parseRunnerArgs, stripPromptValues } from "./args.js";
import { initContextWindow, isoStamp, stdinUserMessage, usageContextTokens } from "./run.js";

describe("isoStamp", () => {
  const d = new Date("2026-09-17T12:19:23Z");

  it("stamps local wall time with the offset, not UTC Z", () => {
    // UTC+2: the 12:19 stamp the pane wrongly showed at local 14:19
    expect(isoStamp(d, 120)).toBe("2026-09-17T14:19:23+02:00");
    expect(isoStamp(d, -300)).toBe("2026-09-17T07:19:23-05:00");
    expect(isoStamp(d, 0)).toBe("2026-09-17T12:19:23+00:00");
  });

  it("rounds half-hour zones correctly", () => {
    expect(isoStamp(d, 330)).toBe("2026-09-17T17:49:23+05:30");
  });

  it("parses back to the same instant (what the viewer's clockOf reads)", () => {
    expect(Date.parse(isoStamp(d, 120))).toBe(d.getTime());
    expect(Date.parse(isoStamp(d, -300))).toBe(d.getTime());
  });
});

describe("stdinUserMessage", () => {
  it("frames text as a stream-json user message", () => {
    expect(JSON.parse(stdinUserMessage("fix the bug"))).toEqual({
      type: "user",
      message: { role: "user", content: "fix the bug" },
    });
  });

  it("keeps newlines inside the content string (one line on stdin)", () => {
    const s = stdinUserMessage("a\nb");
    expect(s.split("\n")).toHaveLength(1);
    expect((JSON.parse(s).message as { content: string }).content).toBe("a\nb");
  });
});

describe("usageContextTokens", () => {
  it("sums input + cache_read + cache_creation + output", () => {
    expect(
      usageContextTokens({
        input_tokens: 1000,
        cache_read_input_tokens: 50000,
        cache_creation_input_tokens: 2000,
        output_tokens: 800,
      })
    ).toBe(53800);
  });

  it("treats missing fields as zero, all-zero as null", () => {
    expect(usageContextTokens({ input_tokens: 12 })).toBe(12);
    expect(usageContextTokens({})).toBeNull();
    expect(usageContextTokens(undefined)).toBeNull();
  });
});

describe("initContextWindow", () => {
  it("prefers context_window, falls back to model_info", () => {
    expect(initContextWindow({ context_window: 100000, model_info: { context_window: 5 } })).toBe(100000);
    expect(initContextWindow({ model_info: { context_window: 200000 } })).toBe(200000);
  });

  it("null when the endpoint announced nothing", () => {
    expect(initContextWindow({})).toBeNull();
    expect(initContextWindow({ context_window: 0 })).toBeNull();
  });
});

describe("parseRunnerArgs", () => {
  it("extracts prompt, output-format and the passthrough tail", () => {
    const p = parseRunnerArgs(["-p", "do it", "--output-format", "json", "--allowedTools", "Read"]);
    expect(p).toMatchObject({ prompt: "do it", outputFormat: "json", headless: true });
    expect(p.rest).toEqual(["-p", "do it", "--allowedTools", "Read"]);
  });

  it("collects --mcp allowlist names (repeatable, = form)", () => {
    expect(parseRunnerArgs(["--mcp", "office", "--mcp=fetcher", "-p", "t"]).mcp).toEqual([
      "office",
      "fetcher",
    ]);
  });

  it("notes caller overrides it must not clobber", () => {
    const p = parseRunnerArgs([
      "--model",
      "big-1",
      "--mcp-config",
      "/tmp/x.json",
      "--append-system-prompt",
      "be terse",
      "-p",
      "t",
    ]);
    expect(p.callerModel).toBe(true);
    expect(p.callerMcpConfig).toBe(true);
    expect(p.callerSystemPrompt).toBe(true);
  });

  it("defaults: text format, no overrides", () => {
    const p = parseRunnerArgs(["-p", "t"]);
    expect(p.outputFormat).toBe("text");
    expect(p.callerModel).toBe(false);
    expect(p.callerMcpConfig).toBe(false);
    expect(p.callerSystemPrompt).toBe(false);
    expect(p.mcp).toEqual([]);
  });
});

describe("stripPromptValues", () => {
  it("turns -p VALUE into bare -p, keeps everything else", () => {
    expect(stripPromptValues(["-p", "secret task", "--allowedTools", "Read"])).toEqual([
      "-p",
      "--allowedTools",
      "Read",
    ]);
  });

  it("handles --print and leaves bare -p alone", () => {
    expect(stripPromptValues(["--print", "go", "-p"])).toEqual(["--print", "-p"]);
  });

  it("does not eat the next flag when the value is missing", () => {
    expect(stripPromptValues(["-p", "--verbose"])).toEqual(["-p", "--verbose"]);
  });
});
