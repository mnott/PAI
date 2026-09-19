/**
 * Tests for the run helpers: stream-json stdin framing (2i), the context
 * metering fields (2j) and the runner's argument tail parsing (2i/2j). Pure
 * functions — no claude, no osascript.
 */

import { describe, it, expect, vi } from "vitest";
import { parseRunnerArgs, stripPromptValues } from "./args.js";
import {
  adoptInitModel,
  bumpContextTokens,
  chromeGrantArgs,
  headlessToolGrants,
  initContextWindow,
  isCompactBoundary,
  isoStamp,
  operatorUserText,
  resetContextTokensOnCompact,
  stdinUserMessage,
  usageContextTokens,
  printResult,
  type StreamEvent,
} from "./run.js";
import { OPERATOR_MARK } from "./report.js";

describe("headlessToolGrants", () => {
  it("grants the core tool set when the caller brings no allowedTools", () => {
    // a headless run cannot approve a permission-gated tool mid-flight: with
    // no grant at all, claude drops the file/shell tools entirely
    const args = headlessToolGrants([]);
    expect(args[0]).toBe("--allowedTools");
    expect(args[1].split(",")).toEqual(["Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
  });

  it("stays out of the way when the caller granted tools itself", () => {
    expect(headlessToolGrants(["Read,Bash"])).toEqual([]);
    expect(headlessToolGrants(["mcp__web__fetch"])).toEqual([]);
  });
});

describe("chromeGrantArgs", () => {
  // the bridge is off in a spawned claude; without the flag the grant names a
  // tool that is simply not there, and the run reports TOOL_NOT_AVAILABLE
  it("appends --chrome when a claude-in-chrome tool is allowlisted", () => {
    expect(chromeGrantArgs(["mcp__claude-in-chrome__tabs_context_mcp"])).toEqual(["--chrome"]);
    expect(chromeGrantArgs(["Read,Bash,mcp__claude-in-chrome__read_page"])).toEqual(["--chrome"]);
    expect(chromeGrantArgs(["claude-in-chrome"])).toEqual(["--chrome"]);
  });

  it("adds nothing for a run that did not ask for the browser", () => {
    expect(chromeGrantArgs([])).toEqual([]);
    expect(chromeGrantArgs(["Read,Edit,Bash", "mcp__github__get_issue"])).toEqual([]);
  });

  it("does not duplicate a --chrome the caller passed itself", () => {
    expect(
      chromeGrantArgs(["mcp__claude-in-chrome__tabs_context_mcp"], ["-p", "task", "--chrome"])
    ).toEqual([]);
  });
});

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

describe("operatorUserText", () => {
  it("marks an operator line with the marker the worker contract names", () => {
    expect(operatorUserText("what is your status")).toBe("[operator] what is your status");
    expect(operatorUserText("what is your status")).toBe(`${OPERATOR_MARK} what is your status`);
    const framed = JSON.parse(stdinUserMessage(operatorUserText("hi")));
    expect((framed.message as { content: string }).content).toBe("[operator] hi");
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

  it("derives 1000000 for the [1m] model variant from the suffix", () => {
    expect(initContextWindow({ type: "system", subtype: "init", model: "glm-5.3[1m]" })).toBe(
      1_000_000
    );
    // no window for plain models: the meter hides rather than guess
    expect(initContextWindow({ type: "system", subtype: "init", model: "glm-5.3" })).toBeNull();
  });
});

describe("adoptInitModel", () => {
  const init = (model?: string): StreamEvent => ({ type: "system", subtype: "init", model });

  it("the built-in anthropic provider records the model the run announced", () => {
    // nativeAnthropicProvider resolves models.default to "" so no --model flag
    // is passed; without this the status file reported an empty model forever
    const status = { model: "" };
    adoptInitModel(status, init("claude-opus-5[1m]"));
    expect(status.model).toBe("claude-opus-5[1m]");
  });

  it("never overwrites a model the spawn already resolved", () => {
    const status = { model: "glm-5.3[1m]" };
    adoptInitModel(status, init("claude-opus-5[1m]"));
    expect(status.model).toBe("glm-5.3[1m]");
  });

  it("leaves the field alone when the event announces nothing usable", () => {
    for (const m of [undefined, "", "   "]) {
      const status = { model: "" };
      adoptInitModel(status, init(m));
      expect(status.model).toBe("");
    }
  });
});

describe("bumpContextTokens (monotonic within a segment)", () => {
  const statusOf = (contextTokens?: number | null) => ({ contextTokens });

  it("a smaller later reading never drags the meter down", () => {
    const s = statusOf();
    bumpContextTokens(s, 150_000);
    bumpContextTokens(s, 60_000); // short reply — the reading the operator saw
    bumpContextTokens(s, 90_000);
    expect(s.contextTokens).toBe(150_000);
  });

  it("rises when a later reading is bigger", () => {
    const s = statusOf(100_000);
    bumpContextTokens(s, 120_000);
    expect(s.contextTokens).toBe(120_000);
  });

  it("ignores null and zero readings", () => {
    const s = statusOf(100_000);
    bumpContextTokens(s, null);
    bumpContextTokens(s, 0);
    expect(s.contextTokens).toBe(100_000);
    const fresh = statusOf();
    bumpContextTokens(fresh, null);
    expect(fresh.contextTokens).toBeUndefined();
  });
});

describe("compact boundary resets the floor", () => {
  const statusOf = (contextTokens?: number | null) => ({ contextTokens });

  it("recognises both event spellings", () => {
    expect(isCompactBoundary({ type: "system", subtype: "compact_boundary" })).toBe(true);
    expect(isCompactBoundary({ type: "system", subtype: "compact" })).toBe(true);
    expect(isCompactBoundary({ type: "system", subtype: "init" })).toBe(false);
    expect(isCompactBoundary({ type: "assistant" } as StreamEvent)).toBe(false);
  });

  it("big -> compact reset -> fresh readings win again, smaller ones do not", () => {
    const s = statusOf();
    bumpContextTokens(s, 150_000);
    resetContextTokensOnCompact(s, { type: "system", subtype: "compact_boundary" });
    expect(s.contextTokens).toBeNull(); // the event carries no usage of its own
    bumpContextTokens(s, 40_000); // first post-compact reading re-seeds low
    expect(s.contextTokens).toBe(40_000);
    bumpContextTokens(s, 30_000); // still monotonic after the reset
    expect(s.contextTokens).toBe(40_000);
    bumpContextTokens(s, 200_000); // and rises past the old floor when earned
    expect(s.contextTokens).toBe(200_000);
  });

  it("uses the compact event's own usage when it carries one", () => {
    const s = statusOf();
    bumpContextTokens(s, 150_000);
    resetContextTokensOnCompact(s, { type: "system", subtype: "compact", usage: { input_tokens: 5_000 } });
    expect(s.contextTokens).toBe(5_000);
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

  it("collects --allowedTools grants without dropping them from the tail", () => {
    const p = parseRunnerArgs([
      "--allowedTools",
      "Bash,mcp__clickr__check_permissions",
      "--allowedTools=mcp__memory",
      "-p",
      "t",
    ]);
    expect(p.allowedTools).toEqual(["Bash,mcp__clickr__check_permissions", "mcp__memory"]);
    expect(p.rest).toContain("--allowedTools");
    expect(p.rest).toContain("Bash,mcp__clickr__check_permissions");
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
    expect(p.allowedTools).toEqual([]);
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

describe("printResult", () => {
  const ev: StreamEvent = { type: "result", result: "the answer", is_error: false };
  const report = { notes: "headline" };

  it("json: prints exactly one JSON line carrying the result text and the parsed report", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printResult("json", ev, 0, "/log", "w1", report);
      expect(log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(log.mock.calls[0][0] as string);
      expect(payload.result).toBe("the answer");
      expect(payload.report).toEqual({ notes: "headline" });
    } finally {
      log.mockRestore();
    }
  });

  it("json without a report omits the report key", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printResult("json", ev, 0, "/log", "w1", null);
      const payload = JSON.parse(log.mock.calls[0][0] as string);
      expect(payload.result).toBe("the answer");
      expect(payload).not.toHaveProperty("report");
    } finally {
      log.mockRestore();
    }
  });

  it("json with no result event still prints one line saying so", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printResult("json", null, 1, "/log", "w1", null);
      expect(log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(log.mock.calls[0][0] as string);
      expect(payload.result).toBe("no result event");
      expect(payload.is_error).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("text: prints the raw result text", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printResult("text", ev, 0, "/log", "w1", report);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toBe("the answer");
    } finally {
      log.mockRestore();
    }
  });

  it("text with no result event writes the stderr pointer", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errW = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printResult("text", null, 1, "/log", "w1", null);
      expect(log).not.toHaveBeenCalled();
      expect(errW.mock.calls[0][0]).toMatch(/run produced no result/);
    } finally {
      log.mockRestore();
      errW.mockRestore();
    }
  });

  it("stream-json: prints nothing (events were mirrored live)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printResult("stream-json", ev, 0, "/log", "w1", null);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
