/**
 * Tests for the run helpers: stream-json stdin framing (2i), the context
 * metering fields (2j) and the runner's argument tail parsing (2i/2j). Pure
 * functions — no claude, no osascript.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { longInlinePromptHint, parseRunnerArgs, stripPromptValues } from "./args.js";
import {
  adoptInitModel,
  bumpContextTokens,
  chromeGrantArgs,
  ensureToolSearch,
  headlessPromptText,
  headlessToolGrants,
  headlessToolsFlag,
  initContextWindow,
  interactiveMcpTools,
  isCompactBoundary,
  isoStamp,
  modelArgs,
  modelFlagArgs,
  operatorUserText,
  reaskAg2Report,
  resetContextTokensOnCompact,
  resolveReportFormat,
  resolveRunModel,
  runSucceeded,
  shouldRetryReport,
  stdinUserMessage,
  usageContextTokens,
  printResult,
  type StreamEvent,
} from "./run.js";
import { AG2_REASK_TEXT, OPERATOR_MARK, promptTrailer } from "./report.js";
import { nativeAnthropicProvider, parseWorkersConfig } from "./config.js";
import { describeProviders } from "./providers.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

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

describe("headlessToolsFlag", () => {
  it("no --tools when the caller granted nothing (today's default-grant behavior)", () => {
    expect(headlessToolsFlag([])).toEqual([]);
  });

  it("built-in names pass through, deduplicated", () => {
    const args = headlessToolsFlag(["Read,Edit,Write,Bash,Grep,Glob"]);
    expect(args[0]).toBe("--tools");
    expect(args[1].split(",")).toEqual(["Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
  });

  it("maps a Bash(pattern) grant to the bare tool name, deduplicated", () => {
    expect(headlessToolsFlag(["Bash(git *)", "Read", "Bash(npm *)"])).toEqual([
      "--tools",
      "Bash,Read",
    ]);
  });

  it("drops mcp__ grants — they load via --mcp-config, not --tools (verified 2026-09-20)", () => {
    expect(headlessToolsFlag(["Read,mcp__pai__memory_search"])).toEqual(["--tools", "Read"]);
  });

  it("multiple --allowedTools flags all contribute", () => {
    expect(headlessToolsFlag(["Read", "Bash,Grep"])).toEqual(["--tools", "Read,Bash,Grep"]);
  });
});

describe("ensureToolSearch", () => {
  it("appends ToolSearch to an existing --tools value", () => {
    const out = ensureToolSearch(["claude", "--tools", "Bash,Read,Grep,Glob,Agent"]);
    expect(out).toEqual(["claude", "--tools", "Bash,Read,Grep,Glob,Agent,ToolSearch"]);
  });

  it("leaves the argv untouched when ToolSearch is already present", () => {
    const argv = ["claude", "--tools", "Read,ToolSearch"];
    expect(ensureToolSearch(argv)).toEqual(argv);
  });

  it("handles the --tools=value form", () => {
    expect(ensureToolSearch(["claude", "--tools=Read,Bash"])).toEqual(["claude", "--tools=Read,Bash,ToolSearch"]);
  });

  it("does nothing when there is no --tools flag at all", () => {
    const argv = ["claude", "-p", "task", "--allowedTools", "Read"];
    expect(ensureToolSearch(argv)).toEqual(argv);
  });

  it("does not touch an empty --tools value", () => {
    expect(ensureToolSearch(["claude", "--tools", ""])).toEqual(["claude", "--tools", ""]);
  });
});

describe("resolveReportFormat", () => {
  it("defaults to ag2 with no flag and no env", () => {
    expect(resolveReportFormat(undefined, {})).toBe("ag2");
  });

  it("PAI_WORKER_REPORT=json selects json when no flag was passed", () => {
    expect(resolveReportFormat(undefined, { PAI_WORKER_REPORT: "json" })).toBe("json");
  });

  it("an explicit flag always wins over the env default", () => {
    expect(resolveReportFormat("ag2", { PAI_WORKER_REPORT: "json" })).toBe("ag2");
    expect(resolveReportFormat("json", {})).toBe("json");
  });
});

describe("modelFlagArgs", () => {
  it("interactive + no explicit --model: no --model arg (settings.json model applies)", () => {
    expect(modelFlagArgs(false, "claude-sonnet-5", false)).toEqual([]);
  });

  it("interactive + caller's own --model: still nothing here (it is already in the passthrough args)", () => {
    expect(modelFlagArgs(false, "claude-sonnet-5", true)).toEqual([]);
  });

  it("headless: the resolved class model is present", () => {
    expect(modelFlagArgs(true, "claude-sonnet-5", false)).toEqual(["--model", "claude-sonnet-5"]);
  });

  it("headless + caller's own --model: not duplicated here either", () => {
    expect(modelFlagArgs(true, "claude-sonnet-5", true)).toEqual([]);
  });
});

describe("headlessPromptText", () => {
  it("appends the ag2 trailer for a headless run", () => {
    const r = headlessPromptText("do the task", true, false, "ag2");
    expect(r.applied).toBe(true);
    expect(r.text).toBe("do the task" + promptTrailer("ag2"));
  });

  it("appends the json trailer for a headless json-format run", () => {
    const r = headlessPromptText("do the task", true, false, "json");
    expect(r.applied).toBe(true);
    expect(r.text).toContain("JSON object only");
  });

  it("never applies to an interactive launch (no -p)", () => {
    const r = headlessPromptText(null, false, false, "ag2");
    expect(r.applied).toBe(false);
    expect(r.text).toBeNull();
  });

  it("never applies when the caller brought its own system prompt", () => {
    const r = headlessPromptText("do the task", true, true, "ag2");
    expect(r.applied).toBe(false);
    expect(r.text).toBe("do the task");
  });

  it("never applies to a headless run with no prompt text", () => {
    const r = headlessPromptText(null, true, false, "ag2");
    expect(r.applied).toBe(false);
    expect(r.text).toBeNull();
  });
});

describe("shouldRetryReport", () => {
  it("retries an invalid report caught by a real validator, with a session and no opt-out", () => {
    expect(shouldRetryReport({ ok: false, validator: "aibroker" }, false, true)).toBe(true);
  });

  it("never retries a valid report", () => {
    expect(shouldRetryReport({ ok: true, validator: "aibroker" }, false, true)).toBe(false);
  });

  it("never retries when no validator ran (a missing aibroker must not block further)", () => {
    expect(shouldRetryReport({ ok: false, validator: "none" }, false, true)).toBe(false);
  });

  it("never retries when the caller opted out with --no-report-retry", () => {
    expect(shouldRetryReport({ ok: false, validator: "aibroker" }, true, true)).toBe(false);
  });

  it("never retries with no session to resume into", () => {
    expect(shouldRetryReport({ ok: false, validator: "aibroker" }, false, false)).toBe(false);
  });
});

describe("reaskAg2Report", () => {
  function fakeProc() {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
    proc.stdout = new EventEmitter();
    proc.kill = vi.fn();
    return proc;
  }

  afterEach(() => {
    vi.mocked(childProcess.spawn).mockReset();
  });

  it("resumes the session with the fixed re-ask text and returns the parsed result", async () => {
    const proc = fakeProc();
    vi.mocked(childProcess.spawn).mockReturnValue(proc as unknown as ReturnType<typeof childProcess.spawn>);

    const promise = reaskAg2Report({
      env: { PATH: "/bin" },
      cwd: "/work",
      model: "claude-sonnet-5",
      callerPinnedModel: false,
      chromeArgs: [],
      mcpArgs: ["--strict-mcp-config", "--mcp-config", "/tmp/none.json"],
      toolArgs: [],
      toolsFlag: [],
      sessionId: "sess-123",
    });

    const [cmd, cmdArgs] = vi.mocked(childProcess.spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("claude");
    expect(cmdArgs).toContain("--resume");
    expect(cmdArgs[cmdArgs.indexOf("--resume") + 1]).toBe("sess-123");
    expect(cmdArgs).toContain(AG2_REASK_TEXT);
    expect(cmdArgs).toEqual(expect.arrayContaining(["--model", "claude-sonnet-5"]));

    proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "R\nr=+\nu=fixed" })));
    proc.emit("close", 0);

    expect(await promise).toBe("R\nr=+\nu=fixed");
  });

  it("does not force --model when the caller pinned one", async () => {
    const proc = fakeProc();
    vi.mocked(childProcess.spawn).mockReturnValue(proc as unknown as ReturnType<typeof childProcess.spawn>);

    const promise = reaskAg2Report({
      env: {},
      cwd: "/work",
      model: "claude-opus-5",
      callerPinnedModel: true,
      chromeArgs: [],
      mcpArgs: [],
      toolArgs: [],
      toolsFlag: [],
      sessionId: "sess-456",
    });
    const [, cmdArgs] = vi.mocked(childProcess.spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmdArgs).not.toContain("--model");

    proc.emit("close", 1);
    await promise;
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

describe("interactiveMcpTools — the interactive launch's project-pin vs. explicit-flag decision", () => {
  it("a project with both mcp and tools pinned: both apply", () => {
    const launch = { mcp: ["aibroker", "pai"], tools: ["Read", "Bash"] };
    expect(interactiveMcpTools([], false, launch)).toEqual({
      mcpNames: ["aibroker", "pai"],
      tools: ["Read", "Bash"],
    });
  });

  it("a project with no pin: neither applies", () => {
    expect(interactiveMcpTools([], false, null)).toEqual({ mcpNames: [], tools: [] });
    expect(interactiveMcpTools([], false, {})).toEqual({ mcpNames: [], tools: [] });
  });

  it("an explicit --mcp on the command line overrides the project's mcp pin", () => {
    const launch = { mcp: ["aibroker", "pai"], tools: ["Read"] };
    expect(interactiveMcpTools(["clickr"], false, launch)).toEqual({
      mcpNames: ["clickr"],
      tools: ["Read"], // the mcp override does not touch the tools pin
    });
  });

  it("a caller --tools suppresses the project's tools pin, leaving mcp alone", () => {
    const launch = { mcp: ["aibroker"], tools: ["Read"] };
    expect(interactiveMcpTools([], true, launch)).toEqual({ mcpNames: ["aibroker"], tools: [] });
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

describe("resolveRunModel / modelArgs — the built-in provider names its model", () => {
  // A headless claude with no --model takes the interactive session default;
  // a probe once came up on the most expensive tier because the chat session
  // had been switched to it. Workers exist to save cost, so the built-in
  // provider resolves through a model table like any other (2026-09-19).
  const native = () => ({ provider: nativeAnthropicProvider(), modelAlias: null });

  it("anthropic with no --model resolves the sonnet default and passes --model", () => {
    const model = resolveRunModel(native(), "implement");
    expect(model).toBe("claude-sonnet-5");
    expect(modelArgs(model, false)).toEqual(["--model", "claude-sonnet-5"]);
  });

  it("no class at all still resolves the default, never an empty model", () => {
    const model = resolveRunModel(native());
    expect(model).toBe("claude-sonnet-5");
    expect(modelArgs(model, false)).toEqual(["--model", "claude-sonnet-5"]);
  });

  it("--class spotcheck and --class simple resolve the fast model (haiku)", () => {
    expect(resolveRunModel(native(), "spotcheck")).toBe("claude-haiku-4-5-20251001");
    expect(resolveRunModel(native(), "simple")).toBe("claude-haiku-4-5-20251001");
    expect(modelArgs(resolveRunModel(native(), "spotcheck"), false)).toEqual([
      "--model",
      "claude-haiku-4-5-20251001",
    ]);
  });

  it("an explicit --model wins over both the class and the provider table", () => {
    expect(resolveRunModel(native(), "spotcheck", "claude-opus-5")).toBe("claude-opus-5");
    expect(resolveRunModel(native(), "implement", "claude-opus-5")).toBe("claude-opus-5");
  });

  it("a class alias (provider/fast) names the capability on any provider", () => {
    expect(resolveRunModel({ provider: nativeAnthropicProvider(), modelAlias: "fast" }, "implement")).toBe(
      "claude-haiku-4-5-20251001"
    );
  });

  it("a provider without a fast model falls back to its default for the cheap classes", () => {
    const glm = parseWorkersConfig({
      providers: { glm: { enabled: true, baseUrl: "https://example.invalid", models: { default: "glm-x" } } },
    }).providers.glm;
    expect(resolveRunModel({ provider: glm, modelAlias: null }, "spotcheck")).toBe("glm-x");
  });

  it("a caller that pinned --model in the claude args is not clobbered", () => {
    expect(modelArgs("claude-sonnet-5", true)).toEqual([]);
    expect(modelArgs("", false)).toEqual([]);
  });

  it("the providers listing shows the built-in default and fast models", () => {
    const lines = describeProviders(parseWorkersConfig({ active: "anthropic", providers: {} }));
    expect(lines[0]).toMatch(/^anthropic {2}\[built-in, active\]/);
    expect(lines[1]).toBe("    default claude-sonnet-5  fast claude-haiku-4-5-20251001  image (none)");
  });
});

describe("adoptInitModel", () => {
  const init = (model?: string): StreamEvent => ({ type: "system", subtype: "init", model });

  it("a spawn that could not name a model records the one the run announced", () => {
    // e.g. the caller pinned --model in the claude args, so the spawn recorded
    // ""; without this the status file reported an empty model forever
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

describe("longInlinePromptHint", () => {
  it("null for a short single-line prompt", () => {
    expect(longInlinePromptHint("print OK")).toBeNull();
  });

  it("null for null/empty", () => {
    expect(longInlinePromptHint(null)).toBeNull();
    expect(longInlinePromptHint("")).toBeNull();
  });

  it("hints when the prompt is over ~600 characters", () => {
    const hint = longInlinePromptHint("x".repeat(601));
    expect(hint).toBe(
      "hint: long inline prompts break on shell quoting — write the spec to a file and use --spec <file>"
    );
  });

  it("hints when the prompt has more than 3 newlines, even if short", () => {
    expect(longInlinePromptHint("a\nb\nc\nd\ne")).not.toBeNull();
  });

  it("no hint at or under the thresholds", () => {
    expect(longInlinePromptHint("x".repeat(600))).toBeNull();
    expect(longInlinePromptHint("a\nb\nc\nd")).toBeNull();
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

describe("runSucceeded", () => {
  it("interactive: a clean exit is done even without a result event", () => {
    // the chat pane never emits stream-json, so rc is the whole verdict
    expect(runSucceeded(false, 0, null)).toBe(true);
  });
  it("interactive: a non-zero exit is still a failure", () => {
    expect(runSucceeded(false, 143, null)).toBe(false);
  });
  it("headless: rc 0 without a result event is a failure", () => {
    expect(runSucceeded(true, 0, null)).toBe(false);
    expect(runSucceeded(true, 0, { is_error: true })).toBe(false);
  });
  it("headless: rc 0 with a clean result event is done", () => {
    expect(runSucceeded(true, 0, { is_error: false })).toBe(true);
    expect(runSucceeded(true, 1, { is_error: false })).toBe(false);
  });
});
