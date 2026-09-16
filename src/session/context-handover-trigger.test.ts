import { describe, it, expect, vi } from "vitest";
import { checkAndEnqueueContextHandover, type HandoverTriggerDeps } from "./context-handover-trigger.js";
import type { ContextFillReading, ThresholdName } from "../hooks/ts/lib/context-fill.js";

function readingAt(usedTokens: number, windowSize = 1_000_000): ContextFillReading {
  return { status: "ok", usedTokens, windowSize, fraction: usedTokens / windowSize, source: "statusline" };
}

function makeDeps(overrides: Partial<HandoverTriggerDeps> & { fired?: ThresholdName[] } = {}): {
  deps: HandoverTriggerDeps;
  enqueued: Array<{ threshold: ThresholdName; urgent: boolean }>;
  savedFired: ThresholdName[][];
} {
  const enqueued: Array<{ threshold: ThresholdName; urgent: boolean }> = [];
  const savedFired: ThresholdName[][] = [];
  let fired = overrides.fired ?? [];

  const deps: HandoverTriggerDeps = {
    getReading: overrides.getReading ?? (() => readingAt(0)),
    loadFired: overrides.loadFired ?? (() => fired),
    saveFired: overrides.saveFired ?? ((_id, next) => {
      fired = next;
      savedFired.push(next);
    }),
    enqueue: overrides.enqueue ?? (async (payload) => {
      enqueued.push({ threshold: payload.threshold, urgent: payload.urgent });
    }),
  };

  return { deps, enqueued, savedFired };
}

const input = { sessionId: "s1", cwd: "/proj" };

describe("checkAndEnqueueContextHandover", () => {
  it("does nothing when the reading is unknown", async () => {
    const { deps, enqueued } = makeDeps({
      getReading: () => ({ status: "unknown", usedTokens: null, windowSize: 1_000_000, fraction: null, source: "unknown" }),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("does nothing below warmup", async () => {
    // effectiveTrigger with default 80% override on a 1M window = 800,000;
    // warmup = 700,000. 500,000 is well below it.
    const { deps, enqueued } = makeDeps({ getReading: () => readingAt(500_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("fires warmup on a clean crossing and enqueues one job", async () => {
    const { deps, enqueued, savedFired } = makeDeps({ getReading: () => readingAt(710_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual(["warmup"]);
    expect(enqueued).toEqual([{ threshold: "warmup", urgent: false }]);
    expect(savedFired[0]).toEqual(["warmup"]);
  });

  it("does not re-fire warmup on a second check at the same or higher level", async () => {
    const { deps, enqueued } = makeDeps({ fired: ["warmup"], getReading: () => readingAt(720_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("fires refresh once warmup has already fired and the session climbs further", async () => {
    const { deps, enqueued } = makeDeps({ fired: ["warmup"], getReading: () => readingAt(765_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual(["refresh"]);
    expect(enqueued).toEqual([{ threshold: "refresh", urgent: false }]);
  });

  it("catches up on both thresholds in ONE enqueue when first observed already past both", async () => {
    const { deps, enqueued, savedFired } = makeDeps({ getReading: () => readingAt(999_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual(["warmup", "refresh"]);
    // One job, not two — tagged with the more urgent (later) threshold.
    expect(enqueued).toEqual([{ threshold: "refresh", urgent: true }]);
    expect(savedFired[0]).toEqual(["warmup", "refresh"]);
  });

  it("marks urgent when at or above the immediate floor", async () => {
    const { deps, enqueued } = makeDeps({ getReading: () => readingAt(786_000) }); // immediate = 785,000
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual(["warmup", "refresh"]);
    expect(enqueued[0].urgent).toBe(true);
  });

  it("does nothing once both thresholds have already fired — never checks the daemon again", async () => {
    const getReading = vi.fn(() => readingAt(999_000));
    const { deps, enqueued } = makeDeps({ fired: ["warmup", "refresh"], getReading });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual([]);
    expect(enqueued).toEqual([]);
    // Short-circuits before even reading the context fill.
    expect(getReading).not.toHaveBeenCalled();
  });

  it("does not mark fired when the enqueue fails, so it is retried next check", async () => {
    const { deps, savedFired } = makeDeps({
      getReading: () => readingAt(710_000),
      enqueue: async () => {
        throw new Error("daemon unreachable");
      },
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual([]);
    expect(savedFired).toEqual([]);
  });

  it("never throws even when enqueue rejects", async () => {
    const { deps } = makeDeps({
      getReading: () => readingAt(710_000),
      enqueue: async () => {
        throw new Error("boom");
      },
    });
    await expect(checkAndEnqueueContextHandover(input, deps)).resolves.toEqual([]);
  });
});
