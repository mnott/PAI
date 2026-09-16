import { describe, it, expect, vi } from "vitest";
import { checkAndEnqueueContextHandover, type HandoverTriggerDeps, type HandoverTriggerState } from "./context-handover-trigger.js";
import type { ContextFillReading, ThresholdName } from "../hooks/ts/lib/context-fill.js";
import type { ContextHandoverCache } from "../hooks/ts/lib/context-handover-cache.js";

function readingAt(usedTokens: number, windowSize = 1_000_000): ContextFillReading {
  return { status: "ok", usedTokens, windowSize, fraction: usedTokens / windowSize, source: "statusline" };
}

function makeDeps(overrides: {
  state?: HandoverTriggerState;
  cache?: ContextHandoverCache | null;
  getReading?: HandoverTriggerDeps["getReading"];
  enqueue?: HandoverTriggerDeps["enqueue"];
  now?: number;
} = {}): {
  deps: HandoverTriggerDeps;
  enqueued: Array<{ threshold: ThresholdName; urgent: boolean }>;
  savedStates: HandoverTriggerState[];
  setCache: (c: ContextHandoverCache | null) => void;
  setNow: (n: number) => void;
} {
  const enqueued: Array<{ threshold: ThresholdName; urgent: boolean }> = [];
  const savedStates: HandoverTriggerState[] = [];
  let state: HandoverTriggerState = overrides.state ?? { confirmed: [], pending: null };
  let cache: ContextHandoverCache | null = overrides.cache ?? null;
  let now = overrides.now ?? Date.now();

  const deps: HandoverTriggerDeps = {
    getReading: overrides.getReading ?? (() => readingAt(0)),
    loadState: () => state,
    saveState: (_id, next) => {
      state = next;
      savedStates.push(next);
    },
    readCache: () => cache,
    enqueue: overrides.enqueue ?? (async (payload) => {
      enqueued.push({ threshold: payload.threshold, urgent: payload.urgent });
    }),
    now: () => now,
  };

  return {
    deps,
    enqueued,
    savedStates,
    setCache: (c) => { cache = c; },
    setNow: (n) => { now = n; },
  };
}

const input = { sessionId: "s1", cwd: "/proj" };

function makeCache(overrides: Partial<ContextHandoverCache> = {}): ContextHandoverCache {
  return {
    sessionId: "s1",
    cwd: "/proj",
    threshold: "warmup",
    generatedAt: new Date().toISOString(),
    model: "sonnet",
    summary: "some handover text",
    ...overrides,
  };
}

describe("checkAndEnqueueContextHandover — enqueue attempt vs confirmed outcome", () => {
  it("does nothing when the reading is unknown", async () => {
    const { deps, enqueued } = makeDeps({
      getReading: () => ({ status: "unknown", usedTokens: null, windowSize: 1_000_000, fraction: null, source: "unknown" }),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("does nothing below warmup", async () => {
    const { deps, enqueued } = makeDeps({ getReading: () => readingAt(500_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("enqueues on a clean crossing but does NOT mark confirmed — only attempted", async () => {
    const { deps, enqueued, savedStates } = makeDeps({ getReading: () => readingAt(710_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: ["warmup"], confirmed: [] });
    expect(enqueued).toEqual([{ threshold: "warmup", urgent: false }]);
    // THE BUG THIS FIXES: the persisted state must NOT say "warmup" is done —
    // only that it is pending, awaiting outcome confirmation.
    expect(savedStates[0].confirmed).toEqual([]);
    expect(savedStates[0].pending?.thresholds).toEqual(["warmup"]);
  });

  it("does not re-enqueue while a threshold is pending (worker may still be running)", async () => {
    const pendingAt = new Date(Date.now() - 10_000).toISOString(); // 10s ago — well inside the timeout
    const { deps, enqueued } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup"], enqueuedAt: pendingAt } },
      getReading: () => readingAt(720_000),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("CONFIRMS a pending threshold once a fresher handover cache appears", async () => {
    const pendingAt = new Date(Date.now() - 10_000).toISOString();
    const { deps, savedStates } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup"], enqueuedAt: pendingAt } },
      cache: makeCache({ generatedAt: new Date().toISOString(), threshold: "warmup" }), // newer than pendingAt
      getReading: () => readingAt(720_000),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result.confirmed).toEqual(["warmup"]);
    expect(savedStates[0].confirmed).toEqual(["warmup"]);
    expect(savedStates[0].pending).toBeNull();
  });

  it("does NOT confirm from a STALE cache older than the pending attempt (a leftover from an earlier session)", async () => {
    const pendingAt = new Date(Date.now() - 10_000).toISOString();
    const staleCache = makeCache({ generatedAt: new Date(Date.now() - 60_000).toISOString() }); // older than pendingAt
    const { deps, enqueued } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup"], enqueuedAt: pendingAt } },
      cache: staleCache,
      getReading: () => readingAt(720_000),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    // Neither confirmed (stale) nor re-attempted (still within the timeout window).
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("THE LIVE BUG, REPRODUCED AND FIXED: a pending attempt that never produces a cache is retried after it times out, not marked done forever", async () => {
    const longAgo = Date.now() - 10 * 60 * 1000; // 10 minutes ago — past PENDING_TIMEOUT_MS (5 min)
    const { deps, enqueued, savedStates } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup", "refresh"], enqueuedAt: new Date(longAgo).toISOString() } },
      cache: null, // the daemon died mid-spawn — no cache was ever written
      getReading: () => readingAt(999_000), // still well past both thresholds
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    // Old bug: this session's marker said {"fired":["warmup","refresh"]} forever,
    // with no cache and no retry. Fixed behaviour: the timed-out pending clears,
    // both thresholds cross again, and a fresh enqueue happens.
    expect(result.attempted).toEqual(["warmup", "refresh"]);
    expect(enqueued).toEqual([{ threshold: "refresh", urgent: true }]);
    const finalState = savedStates[savedStates.length - 1];
    expect(finalState.confirmed).toEqual([]); // still not confirmed — only re-attempted
    expect(finalState.pending?.thresholds).toEqual(["warmup", "refresh"]);
  });

  it("reads an OLD-FORMAT marker file ({fired:[...]}) as nothing confirmed — self-heals the exact stuck file the bug left behind", async () => {
    // loadTriggerState (the real implementation, not this mock) is what
    // actually parses the old shape; this test exercises that directly.
    const { loadTriggerState, triggerStatePath } = await import("./context-handover-trigger.js");
    const { writeFileSync, unlinkSync, existsSync } = await import("node:fs");
    const sessionId = "old-format-test-session";
    const path = triggerStatePath(sessionId);
    writeFileSync(path, JSON.stringify({ fired: ["warmup", "refresh"] }), "utf-8");
    try {
      const state = loadTriggerState(sessionId);
      expect(state.confirmed).toEqual([]);
      expect(state.pending).toBeNull();
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("does nothing once both thresholds are confirmed — never checks the daemon again", async () => {
    const getReading = vi.fn(() => readingAt(999_000));
    const { deps, enqueued } = makeDeps({
      state: { confirmed: ["warmup", "refresh"], pending: null },
      getReading,
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
    expect(getReading).not.toHaveBeenCalled();
  });

  it("never throws even when enqueue rejects", async () => {
    const { deps } = makeDeps({
      getReading: () => readingAt(710_000),
      enqueue: async () => {
        throw new Error("boom");
      },
    });
    await expect(checkAndEnqueueContextHandover(input, deps)).resolves.toEqual({ attempted: [], confirmed: [] });
  });
});
