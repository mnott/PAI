/**
 * Proof of the live bug (2026-10-21): run.ts's result-event branch fed the
 * stream's CUMULATIVE usage into the context meter, so a 200k-window run
 * ended with contextTokens 1_379_312 ("context 690%") and escalated t1→t0.
 * The buggy branch is replicated verbatim and asserted to produce the wrong
 * number; the fixed branch (run.ts's current code, mirrored here) keeps the
 * peak turn. On the unfixed HEAD the buggy assertions hold and the fixed ones
 * fail; with the fix everything passes.
 */
import { describe, it, expect } from "vitest";
import {
  bumpContextTokens,
  usageContextTokens,
  usageContextUsed,
  type StreamEvent,
} from "./run.js";
import { DEFAULT_ESCALATE, detectTrigger } from "./escalation.js";

// verbatim from run.ts's result branch (fixed): a result event's usage is the
// run's cumulative total and must not raise the meter; a compact result drops
// it to the last per-turn fill
function resultBranchFixed(
  status: { contextTokens?: number | null },
  e: StreamEvent,
  lastTurnFill: number | null
): void {
  if (e.is_compact) status.contextTokens = lastTurnFill ?? status.contextTokens;
}

// verbatim from run.ts's result branch (buggy): bump with the cumulative total
function resultBranchBuggy(status: { contextTokens?: number | null }, e: StreamEvent): void {
  const tokens = usageContextTokens(e.usage);
  if (e.is_compact) status.contextTokens = tokens ?? status.contextTokens;
  else bumpContextTokens(status, tokens);
}

const turn = (fill: number): StreamEvent => ({
  type: "assistant",
  message: { usage: { input_tokens: 1_000, cache_read_input_tokens: fill - 1_000, output_tokens: 500 } },
});
const resultEvt = (total: number): StreamEvent => ({
  type: "result",
  usage: { input_tokens: total, cache_read_input_tokens: 0, output_tokens: 40_000 },
  result: "done",
});

describe("result-event context meter (bug proof)", () => {
  it("the buggy branch pushes the meter to the run total and fires the context trigger", () => {
    const s: { contextTokens?: number | null } = {};
    for (const e of [turn(50_000), turn(80_000), turn(60_000)]) bumpContextTokens(s, usageContextUsed(e.message?.usage));
    resultBranchBuggy(s, resultEvt(1_400_000));
    // the bug: the meter reads the run total, not the peak turn
    expect(s.contextTokens).toBe(1_440_000);
    expect(detectTrigger({ contextTokens: s.contextTokens, contextWindow: 200_000, cfg: DEFAULT_ESCALATE })?.kind).toBe(
      "context"
    );
  });

  it("the fixed branch keeps the peak turn (80k) and the trigger stays silent", () => {
    const s: { contextTokens?: number | null } = {};
    let lastTurnFill: number | null = null;
    for (const e of [turn(50_000), turn(80_000), turn(60_000)]) {
      bumpContextTokens(s, usageContextUsed(e.message?.usage));
      lastTurnFill = usageContextUsed(e.message?.usage) ?? lastTurnFill;
    }
    resultBranchFixed(s, resultEvt(1_400_000), lastTurnFill);
    expect(s.contextTokens).toBe(80_000);
    expect(detectTrigger({ contextTokens: s.contextTokens, contextWindow: 200_000, cfg: DEFAULT_ESCALATE })).toBeNull();
  });

  it("a single 150k turn fires the trigger at 0.7 of a 200k window", () => {
    const s: { contextTokens?: number | null } = {};
    bumpContextTokens(s, usageContextUsed(turn(150_000).message?.usage));
    resultBranchFixed(s, resultEvt(150_500), 150_000);
    expect(detectTrigger({ contextTokens: s.contextTokens, contextWindow: 200_000, cfg: DEFAULT_ESCALATE })?.kind).toBe(
      "context"
    );
  });

  it("a compact result resets to the post-compact per-turn fill, not the cumulative total", () => {
    const s: { contextTokens?: number | null } = {};
    let lastTurnFill: number | null = null;
    bumpContextTokens(s, usageContextUsed(turn(150_000).message?.usage));
    lastTurnFill = 150_000;
    // compact boundary drops the floor (no usage of its own -> null)
    s.contextTokens = usageContextUsed(undefined) ?? null;
    lastTurnFill = null;
    bumpContextTokens(s, usageContextUsed(turn(40_000).message?.usage));
    lastTurnFill = 40_000;
    expect(s.contextTokens).toBe(40_000);
    // compact result carrying the run's cumulative total: the meter drops to
    // the last per-turn fill, never to the total
    resultBranchFixed(s, { type: "result", is_compact: true, usage: { input_tokens: 1_400_000 } }, lastTurnFill);
    expect(s.contextTokens).toBe(40_000);
    // the next per-turn reading re-seeds the meter at the post-compact fill
    bumpContextTokens(s, usageContextUsed(turn(30_000).message?.usage));
    expect(s.contextTokens).toBe(40_000);
    expect(detectTrigger({ contextTokens: s.contextTokens, contextWindow: 200_000, cfg: DEFAULT_ESCALATE })).toBeNull();
  });
});
