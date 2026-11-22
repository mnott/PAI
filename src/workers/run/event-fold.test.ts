import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopStopResult } from "./finalise.js";
import { createResultFold, finalResultEvent, type StreamEventLike } from "./event-fold.js";

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
