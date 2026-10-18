import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCoalesced, getStats, markCompleted, markFailed, resetQueueForTests, NonRetryableError, enqueue, dequeue } from "./work-queue.js";
import {
  REGISTRY_SCAN_COALESCE_MS,
  registryScanIgnoredReason,
  triggerRegistryScan,
} from "./registry-scan-trigger.js";

beforeEach(() => {
  resetQueueForTests();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("registry-scan coalescing", () => {
  it("collapses a burst of triggers into one queued item", () => {
    const t = Date.now();
    const results = Array.from({ length: 50 }, () => triggerRegistryScan(undefined, t));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(getStats().pending).toBe(1);
  });

  it("does not queue while one is running", () => {
    const t = Date.now();
    triggerRegistryScan(undefined, t);
    dequeue();
    expect(triggerRegistryScan(undefined, t)).toBeNull();
  });

  it("suppresses repeats inside the window after completion, allows after", () => {
    const t = Date.now();
    const first = triggerRegistryScan(undefined, t)!;
    dequeue();
    markCompleted(first.id);
    expect(triggerRegistryScan(undefined, t + REGISTRY_SCAN_COALESCE_MS - 1000)).toBeNull();
    expect(triggerRegistryScan(undefined, t + REGISTRY_SCAN_COALESCE_MS + 1000)).not.toBeNull();
  });

  it("coalesces per type", () => {
    enqueue({ type: "session-end", payload: {} });
    expect(enqueueCoalesced({ type: "registry-scan", payload: {} }, 1000)).not.toBeNull();
  });
});

describe("registry-scan path filter", () => {
  it("ignores worker worktrees, temp dirs and worker log dirs", () => {
    expect(registryScanIgnoredReason("/Users/x/.claude/pai/logs/workers/worktrees/abc")).toBeDefined();
    expect(registryScanIgnoredReason("/private/tmp/proof")).toBeDefined();
    expect(registryScanIgnoredReason("/Users/x/proj/.claude/worktrees/cool")).toBeDefined();
  });

  it("keeps ordinary paths and missing cwd", () => {
    expect(registryScanIgnoredReason("/Users/x/Development/proj")).toBeUndefined();
    expect(registryScanIgnoredReason(undefined)).toBeUndefined();
  });

  it("drops a trigger from a filtered path without queueing", () => {
    expect(triggerRegistryScan("/Users/x/.claude/pai/logs/workers/worktrees/abc")).toBeNull();
    expect(getStats().total).toBe(0);
  });
});

describe("non-retryable failure", () => {
  it("fails at once instead of scheduling a retry", () => {
    const item = enqueue({ type: "context-handover", payload: {} });
    dequeue();
    markFailed(item.id, new NonRetryableError("x").message, false);
    expect(getStats().failed).toBe(1);
    expect(getStats().pending).toBe(0);
  });
});
