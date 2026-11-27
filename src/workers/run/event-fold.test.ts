import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopStopResult, foldContinuationResult } from "./finalise.js";
import type { StreamEvent } from "./types.js";
import { createResultFold, finalResultEvent, type StreamEventLike } from "./event-fold.js";
import { preEventFailure } from "./pane-handles.js";
import { bashResultFailed, isBrainstormCommand, toolResultFailed } from "./stream.js";
import { createToolFold } from "./tool-fold.js";

// The resumed worker's stream (20261119-045451-23508): the replayed task notification and its num_turns-0 result
// arrive BEFORE the real turn for the new prompt; arming the end on that result closed stdin and reaped the
// leftover tree while the first tool call was still running.
const EV = {
  taskNotification: { type: "system", subtype: "task_notification" },
  init: { type: "system", subtype: "init" },
  replayedResult: { type: "result", num_turns: 0, duration_api_ms: 0, result: "" },
  assistantTool: { type: "assistant" },
  toolResult: { type: "user" },
  finalResult: { type: "result", num_turns: 1, result: "R done" },
} satisfies Record<string, StreamEventLike>;

/** The fold wired like execute-fold's: a final result stands for armStdinClose + resultGrace.onResult + record. */
const runFold = (events: StreamEventLike[], resume = false) => {
  const finals: StreamEventLike[] = [];
  let arms = 0;
  const f = createResultFold(
    {
      onTurn: () => undefined,
      onFinalResult: (e) => {
        arms += 1; // armStdinClose() + resultGrace.onResult(), exactly as foldEvent wires them
        finals.push(e);
      },
    },
    { resume }
  );
  for (const e of events) {
    if (e.type === "assistant") f.onAssistant();
    else if (e.type === "result") f.onResult(e);
  }
  return { finals, arms };
};

describe("createResultFold", () => {
  it("the resumed stream: only the last result is final — armed once, after the real turn", () => {
    const { finals, arms } = runFold(
      [EV.taskNotification, EV.init, EV.replayedResult, EV.init, EV.assistantTool, EV.toolResult, EV.finalResult],
      true
    );
    expect(finals).toEqual([EV.finalResult]); // the second result is THE final one
    expect(arms).toBe(1); // stdin close + result grace armed exactly once
  });

  it("a num_turns-0 result with text (an empty-response outcome) still ends the run", () => {
    const outcome = { type: "result", num_turns: 0, duration_api_ms: 0, result: "stopped early" };
    const { finals, arms } = runFold([EV.init, outcome]);
    expect(finals).toEqual([outcome]);
    expect(arms).toBe(1);
  });

  it("a normal run's single result after an assistant turn behaves exactly as before", () => {
    const { finals, arms } = runFold([EV.init, EV.assistantTool, EV.finalResult]);
    expect(finals).toEqual([EV.finalResult]);
    expect(arms).toBe(1);
  });

  it("a fresh (non-resume) run's empty num_turns-0 result ends the run as before — nothing is swallowed", () => {
    const { finals, arms } = runFold([EV.init, EV.replayedResult]); // never resumes: this IS its outcome
    expect(finals).toEqual([EV.replayedResult]);
    expect(arms).toBe(1); // stdin closes; no hang to the deadline
  });
});

describe("finalResultEvent", () => {
  const lines = (events: StreamEventLike[]) => events.map((e) => JSON.stringify(e));
  it("a transcript that ends on a replayed empty result with no turn after it is kept (the run really ended there)", () => {
    // the mid-run case the fold covers: the real turn follows, and the next test's stream proves it is picked
    expect(finalResultEvent(lines([EV.taskNotification, EV.init, EV.replayedResult]))).toEqual(EV.replayedResult);
  });
  it("the real result after the resumed turn is; a trailing replayed one never masks it", () => {
    expect(finalResultEvent(lines([EV.replayedResult, EV.init, EV.assistantTool, EV.finalResult]))).toEqual(EV.finalResult);
  });
  it("keeps a replayed empty result when the transcript truly ends on it (nothing ran after it)", () => {
    expect(finalResultEvent(lines([EV.init, EV.replayedResult]))).toEqual(EV.replayedResult);
  });
});

describe("loopStopResult usage", () => {
  const setup = (events: object[], router: object[]) => {
    const dir = mkdtempSync(join(tmpdir(), "loopstop-"));
    writeFileSync(join(dir, "w1.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const log = join(dir, "router.jsonl");
    writeFileSync(log, router.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return { dir, log };
  };
  const turn = (id: string, out: number) => ({ type: "assistant", session_id: "s1", message: { id, model: "m", usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 10 } } });

  it("sums output and cache usage over the assistant turns", () => {
    const { dir, log } = setup([turn("a", 7), turn("b", 5), turn("c", 3)], []);
    const u = loopStopResult(dir, "w1", "x", 3, 1, log).usage;
    expect(u).toMatchObject({ input_tokens: 300, output_tokens: 15, cache_read_input_tokens: 30 });
  });

  it("takes output from the router ledger when the streamed turns carry output 0", () => {
    const { dir, log } = setup(
      [turn("a", 0), turn("b", 0)],
      [
        { session_id: "s1", status: 200, input_tokens: 1, output_tokens: 60, cache_read_input_tokens: 4, cache_creation_input_tokens: 9 },
        { session_id: "s1", status: 200, input_tokens: 1, output_tokens: 40, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
        { session_id: "other", status: 200, input_tokens: 1, output_tokens: 999 },
      ]
    );
    expect(loopStopResult(dir, "w1", "x", 2, 1, log).usage).toEqual({ input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 });
  });
});

// 2026-11-24: a queue-starved worker stopped by the time budget read "failed before any model
// event: ⚠ claude.ai connectors are disabled …" — a benign stderr line every local worker prints.
const CONNECTORS_WARNING =
  "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to use connectors.";

describe("preEventFailure summary", () => {
  it("skips the benign connectors warning: no failure text from it alone", () => {
    expect(preEventFailure(143, 0, CONNECTORS_WARNING)).toBeNull();
    expect(preEventFailure(143, 0, CONNECTORS_WARNING + "\n")).toBeNull();
  });

  it("keeps a real error when a benign line is mixed in", () => {
    expect(preEventFailure(1, 0, CONNECTORS_WARNING + "\nError: spawn ENOENT")).toBe("failed before any model event: Error: spawn ENOENT");
  });

  it("returns null when the run answered turns or exited clean", () => {
    expect(preEventFailure(0, 0, "anything")).toBeNull();
    expect(preEventFailure(1, 2, "anything")).toBeNull();
  });

  it("uses the kill record's reason when one exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "prefail-kill-"));
    writeFileSync(
      join(dir, "w1.kill"),
      JSON.stringify({ ts: "2026-11-24T12:00:00Z", by: "time-budget", pid: 1, ppid: 2, cwd: "/", reason: "budget checkpoint: no progress in its 20-min allowance" })
    );
    expect(preEventFailure(143, 0, CONNECTORS_WARNING, dir, "w1")).toBe("stopped by time-budget before its first model turn (budget checkpoint: no progress in its 20-min allowance)");
    // the marker is consumed: a second read falls back to stderr (benign → null)
    expect(preEventFailure(143, 0, CONNECTORS_WARNING, dir, "w1")).toBeNull();
  });

  it("a kill record without a stated reason still names who stopped it", () => {
    const dir = mkdtempSync(join(tmpdir(), "prefail-kill2-"));
    writeFileSync(join(dir, "w2.kill"), JSON.stringify({ ts: "t", by: "pane audit", pid: 1, ppid: 2, cwd: "/" }));
    expect(preEventFailure(143, 0, CONNECTORS_WARNING, dir, "w2")).toBe("stopped by pane audit before its first model turn");
  });
});

describe("foldContinuationResult", () => {
  it("sums turns, tokens, duration and cost over the first run and its continuations; the answer is the latest", () => {
    const base: StreamEvent = { type: "result", num_turns: 1, duration_ms: 6414, result: "first", usage: { input_tokens: 1, output_tokens: 10 } };
    (base as Record<string, unknown>).total_cost_usd = 0.03;
    foldContinuationResult(base, { type: "result", num_turns: 2, duration_ms: 5210, result: "second", usage: { input_tokens: 2, output_tokens: 70 } });
    foldContinuationResult(base, { type: "result", num_turns: 45, duration_ms: 687960, result: "All 40 files written", usage: { input_tokens: 5, output_tokens: 9396 }, total_cost_usd: 0.5 } as StreamEvent);
    expect(base.num_turns).toBe(48);
    expect(base.duration_ms).toBe(699584);
    expect(base.usage?.output_tokens).toBe(9476);
    expect(base.usage?.input_tokens).toBe(8);
    expect((base as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.53);
    expect(base.result).toBe("All 40 files written");
  });
});

describe("brainstorm exit codes", () => {
  const res = (text: string) => ({ is_error: true, content: text });
  it("recognises brainstorm wait/post, word-bounded", () => {
    expect(isBrainstormCommand("pai brainstorm wait 3 --since 2")).toBe(true);
    expect(isBrainstormCommand('cd x && pai brainstorm post 3 "a" --as moderator')).toBe(true);
    expect(isBrainstormCommand("pai brainstorm waitress")).toBe(false);
    expect(isBrainstormCommand("echo brainstorm wait")).toBe(false);
  });
  it("exit 3 and 4 of a brainstorm command are not failures", () => {
    for (const code of [3, 4]) {
      const b = res(`Exit code ${code}\nstate=x`);
      expect(toolResultFailed(b)).toBe(true);
      expect(bashResultFailed("pai brainstorm wait 3", b)).toBe(false);
    }
  });
  it("exit 1 of a brainstorm wait still fails; exit 3 of another command fails", () => {
    expect(bashResultFailed("pai brainstorm wait 3", res("Exit code 1\nboom"))).toBe(true);
    expect(bashResultFailed("pai brainstorm wait 3", res("Exit code 2"))).toBe(true);
    expect(bashResultFailed("make test", res("Exit code 3"))).toBe(true);
  });
  it("tool fold records brainstorm exit 3 as not failed in bashRuns", () => {
    const fold = createToolFold({ logDir: tmpdir(), worker: "w", provider: "p", label: "l", granted: [], cwd: tmpdir(), inject: () => {} } as never);
    fold.onToolUse({ id: "a", name: "Bash", input: { command: "pai brainstorm wait 3" } } as never);
    fold.onToolResult({ tool_use_id: "a", is_error: true, content: "Exit code 3" } as never);
    fold.onToolUse({ id: "b", name: "Bash", input: { command: "make" } } as never);
    fold.onToolResult({ tool_use_id: "b", is_error: true, content: "Exit code 3" } as never);
    expect(fold.bashRuns.map((r) => r.failed)).toEqual([false, true]);
  });
});
