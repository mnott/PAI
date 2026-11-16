import { describe, expect, it } from "vitest";
import { escalationReason, URGENT_QUEUED_MIN, type ReroutePolicy } from "./reroute.js";
import type { WorkerStatus } from "./status.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const pol = (queuedMaxMin: number): ReroutePolicy => ({ queuedMaxMin, stallMaxMin: 10, stallFailedCalls: 6 });
const job = (o: Partial<WorkerStatus>): WorkerStatus => ({ id: "w1", state: "queued", spec: "/x", routeWhy: "auto", started: "", capacity: { sinceMs: NOW - 60 * 60_000 }, ...o }) as unknown as WorkerStatus;

describe("escalationReason queued", () => {
  it("queuedMaxMin 0 without urgency: waits", () => {
    expect(escalationReason(job({}), NOW, pol(0))).toBeNull();
  });
  it("queuedMaxMin 0 with urgency: moves after the short fixed wait", () => {
    expect(escalationReason(job({ now: true }), NOW, pol(0))).toContain("queued 60m");
    expect(escalationReason(job({ now: true, capacity: { sinceMs: NOW - 60_000 } } as never), NOW, pol(0))).toBeNull();
    expect(URGENT_QUEUED_MIN).toBe(2);
  });
  it("queuedMaxMin 15 still applies when urgent, never when not", () => {
    expect(escalationReason(job({ now: true }), NOW, pol(15))).not.toBeNull();
    expect(escalationReason(job({ now: true, capacity: { sinceMs: NOW - 5 * 60_000 } } as never), NOW, pol(15))).toBeNull();
    expect(escalationReason(job({}), NOW, pol(15))).toBeNull();
  });
  it("running stall is unchanged", () => {
    const r = job({ state: "running", progressAt: new Date(NOW - 11 * 60_000).toISOString() } as never);
    expect(escalationReason(r, NOW, pol(0))).toContain("no edit or commit");
    expect(escalationReason(job({ state: "running", consecFails: 6 } as never), NOW, pol(0))).toContain("failed tool calls");
  });
});
