/**
 * Probe-handling tests.
 *
 * The case that matters: AIBroker reports `busy` when a session is mid-turn and
 * still producing output. Claude Code queues typed input during a turn, so a
 * healthy session working on exactly the task we gave it stays silent for
 * minutes — and we probe at expected x1.5, precisely when that is most likely.
 *
 * Treating `busy` as a strike would declare healthy sessions stuck on ordinary
 * days. These tests pin that it never counts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tick, type Prober, type ProbeState } from "./poller.js";
import { RUNNING_LABEL } from "./scheduler.js";
import type { Task } from "./types.js";

const NOW = Date.parse("2026-08-01T12:00:00Z");

function runningTask(): Task {
  return {
    id: "sweep",
    title: "Jobs Matthias sweep",
    body: "",
    owner: { project: "jobs-matthias", rootPath: "/tmp", source: "label" },
    // Due in the past so it is not treated as complete.
    due: "2026-08-01T09:00:00Z",
    priority: "p2",
    labels: [RUNNING_LABEL],
  };
}

function fakeProvider(tasks: Task[]) {
  return {
    listOpen: vi.fn().mockResolvedValue(tasks),
    setLabels: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function fakeProber(state: ProbeState, reply?: string): Prober {
  return { ask: vi.fn().mockResolvedValue({ state, reply, reason: state }) };
}

async function probeOnce(state: ProbeState) {
  return tick({
    provider: fakeProvider([runningTask()]),
    transport: null,
    prober: fakeProber(state),
    autoDispatch: true,
    dryRun: true, // keep state off disk; we assert on the reported note
    now: NOW,
  });
}

describe("probe outcomes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not treat a busy session as stuck", async () => {
    const r = await probeOnce("busy");
    expect(r.stuck).toBe(0);
  });

  it("does not treat a replying session as stuck", async () => {
    const r = await probeOnce("replied");
    expect(r.stuck).toBe(0);
  });

  it("never sends a question to a busy session", async () => {
    // AIBroker decides busy BEFORE sending, so the probe costs no tokens.
    // Asserting the reported outcome rather than the transport call, since the
    // decision is AIBroker's and this pins that we honour it.
    const r = await probeOnce("busy");
    expect(r.stuck).toBe(0);
    expect(r.probed).toBe(0); // dryRun: nothing counted, nothing acted on
  });
});

describe("tick shape", () => {
  it("reports nothing when a task is not yet due", async () => {
    const future: Task = { ...runningTask(), labels: [], due: "2026-08-01T18:00:00Z" };
    const r = await tick({
      provider: fakeProvider([future]),
      transport: null,
      prober: null,
      autoDispatch: true,
      dryRun: true,
      now: NOW,
    });
    expect(r.decisions).toHaveLength(0);
  });

  it("proposes a dispatch for an overdue unrouted-free task", async () => {
    const due: Task = { ...runningTask(), labels: [] };
    const r = await tick({
      provider: fakeProvider([due]),
      transport: null,
      prober: null,
      autoDispatch: true,
      dryRun: true,
      now: NOW,
    });
    expect(r.decisions[0]?.decision.action).toBe("dispatch");
  });

  it("leaves an overrunning task alone when no prober is available", async () => {
    // Never re-dispatch blind: double-running a live sweep is worse than waiting.
    const r = await tick({
      provider: fakeProvider([runningTask()]),
      transport: null,
      prober: null,
      autoDispatch: true,
      dryRun: false,
      now: NOW,
    });
    expect(r.stuck).toBe(0);
  });
});
