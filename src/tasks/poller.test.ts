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
    //
    // stateFile is not optional here even though nothing is asserted about it:
    // a non-dry run with no override persists to ~/.pai/scheduler-state.json,
    // the real one. This test had been writing its fixture ids and its frozen
    // clock into the live scheduler's state on every run — found on 2026-08-01
    // by reading that file and seeing a task id that only exists in this file.
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-poller-"));
    try {
      const r = await tick({
        provider: fakeProvider([runningTask()]),
        transport: null,
        prober: null,
        autoDispatch: true,
        dryRun: false,
        now: NOW,
        stateFile: pathJoin(dir, "state.json"),
      });
      expect(r.stuck).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch outcomes
// ---------------------------------------------------------------------------

/**
 * `queued` is delivery, not failure.
 *
 * Measured on 2026-08-01: AIBroker typed a work order into a live session that
 * was mid-turn, saw no reaction inside its window, reported `unreachable`, and
 * retried — so one trigger arrived three times while the scheduler recorded a
 * failed dispatch for a task that was in fact running. AIBroker 0.16.0 now
 * returns `queued` for that case. These pin the PAI half: it must count as
 * success, or the task goes unlabelled and a later tick dispatches it again.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { Transport, TransportResult } from "./dispatch.js";

function dueTask(): Task {
  return {
    id: "sweep",
    title: "Jobs Matthias sweep",
    body: "",
    owner: { project: "jobs-matthias", rootPath: "/tmp", source: "label" },
    due: "2026-08-01T09:00:00Z", // overdue at NOW
    priority: "p2",
    labels: [],
  };
}

function fakeTransport(outcome: TransportResult["outcome"]): Transport {
  return { dispatch: vi.fn().mockResolvedValue({ outcome, session: "jobs-matthias" }) };
}

async function dispatchOnce(outcome: TransportResult["outcome"]) {
  const dir = mkdtempSync(pathJoin(tmpdir(), "pai-poller-"));
  // Built here rather than through fakeProvider so setLabels stays typed —
  // asserting on it is the point of these tests.
  const setLabels = vi.fn().mockResolvedValue(undefined);
  const provider = {
    listOpen: vi.fn().mockResolvedValue([dueTask()]),
    setLabels,
    comment: vi.fn().mockResolvedValue(undefined),
  } as never;

  try {
    const report = await tick({
      provider,
      transport: fakeTransport(outcome),
      prober: null,
      autoDispatch: true,
      dryRun: false,
      now: NOW,
      stateFile: pathJoin(dir, "state.json"),
    });
    return { report, setLabels };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("dispatch outcomes", () => {
  it("treats queued as delivered and marks the task running", () => {
    return dispatchOnce("queued").then(({ report, setLabels }) => {
      const note = report.decisions[0]!.note;
      expect(note).toContain("queued");
      expect(report.stuck).toBe(0);
      // The running label is the guard against a second tick sending it again.
      expect(setLabels).toHaveBeenCalledWith("sweep", [RUNNING_LABEL]);
      // Claimed once and never released — the claim must survive a good dispatch.
      expect(setLabels).toHaveBeenCalledTimes(1);
    });
  });

  it("still treats a genuine unreachable as a failure", () => {
    return dispatchOnce("unreachable").then(({ report, setLabels }) => {
      expect(report.decisions[0]!.note).toContain("not dispatched (1/3)");
      // Claimed, then released: nothing is running, so the label must not stick.
      expect(setLabels).toHaveBeenNthCalledWith(1, "sweep", [RUNNING_LABEL]);
      expect(setLabels).toHaveBeenNthCalledWith(2, "sweep", []);
    });
  });
});

describe("a hand-triggered run keeps its schedule", () => {
  /**
   * The tick restores the date when the box is ticked, but the session ends the
   * run with `pai task done`, which advances the recurrence a second time. Left
   * alone, a sweep triggered on Saturday evening cancelled Sunday morning's.
   */
  function completingTask(): Task {
    return {
      id: "sweep",
      title: "Jobs Matthias sweep",
      body: "",
      owner: { project: "jobs-matthias", rootPath: "/tmp", source: "label" },
      // Advanced into the future by the completion = "the run finished".
      due: "2026-08-03T08:00:00Z",
      recurrence: "every day at 08:00",
      priority: "p2",
      labels: [RUNNING_LABEL],
    };
  }

  async function completeOnce(triggeredRestore: Record<string, string>) {
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-poller-"));
    const stateFile = pathJoin(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ startedAt: { sweep: NOW - 60_000 }, triggeredRestore }));

    const setDue = vi.fn().mockResolvedValue(undefined);
    const provider = {
      listOpen: vi.fn().mockResolvedValue([completingTask()]),
      setLabels: vi.fn().mockResolvedValue(undefined),
      setDue,
      comment: vi.fn().mockResolvedValue(undefined),
    } as never;

    try {
      const report = await tick({
        provider,
        transport: null,
        prober: null,
        autoDispatch: true,
        dryRun: false,
        now: NOW,
        stateFile,
      });
      return { report, setDue };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("writes the kept date back after the completion", async () => {
    const { report, setDue } = await completeOnce({
      sweep: "every day at 08:00 starting 2026-08-02",
    });
    expect(report.completed).toBe(1);
    expect(setDue).toHaveBeenCalledWith("sweep", "every day at 08:00 starting 2026-08-02");
    expect(report.decisions[0]!.note).toContain("hand-triggered");
  });

  it("leaves a normal scheduled run alone", async () => {
    const { report, setDue } = await completeOnce({});
    expect(report.completed).toBe(1);
    expect(setDue).not.toHaveBeenCalled();
  });

  it("does not write back a slot that has already passed", async () => {
    // Would produce a task overdue the instant it is written, which the next
    // tick would dispatch — turning one trigger into an unbounded loop.
    const { setDue } = await completeOnce({
      sweep: "every day at 08:00 starting 2026-07-30",
    });
    expect(setDue).not.toHaveBeenCalled();
  });
});

describe("a webhook-triggered run also keeps its schedule", () => {
  /**
   * The restore machinery is this poller's, but AIBroker's webhook triggers
   * without going through it: the user ticks, the due date advances, the webhook
   * claims and dispatches, and the session ends with `pai task done` — a second
   * advance. Both occurrences consumed, one manual trigger, schedule drifting a
   * day forward every time. Same defect as the poller path, reached another way.
   *
   * A claim appearing at the same moment the due advanced by exactly one period
   * is the signature. Recorded then, applied after the completion — never
   * written mid-run, because AIBroker decides whether a session may release its
   * claim by checking the due date has moved past the occurrence it noted, and
   * moving it under them would make a finished run look unfinished.
   */
  function webhookClaimed(): Task {
    return {
      id: "sweep",
      title: "Jobs Matthias sweep",
      body: "",
      owner: { project: "jobs-matthias", rootPath: "/tmp", source: "label" },
      due: "2026-08-03T08:00:00", // advanced by the user's tick
      recurrence: "every day at 08:00",
      priority: "p2",
      labels: [RUNNING_LABEL], // claimed by the webhook, not by us
    };
  }

  async function tickOver(task: Task, seed: Record<string, unknown>) {
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-poller-"));
    const stateFile = pathJoin(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify(seed));
    const provider = {
      listOpen: vi.fn().mockResolvedValue([task]),
      setLabels: vi.fn().mockResolvedValue(undefined),
      setDue: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    } as never;

    try {
      await tick({
        provider, transport: null, prober: null,
        autoDispatch: true, dryRun: false, now: NOW, stateFile,
      });
      return JSON.parse(readFileSync(stateFile, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("records the consumed occurrence when the webhook claims it", async () => {
    const after = await tickOver(webhookClaimed(), {
      lastSeenDue: { sweep: "2026-08-02T08:00:00" },
    });
    expect(after.triggeredRestore.sweep).toBe("every day at 08:00 starting 2026-08-02");
  });

  it("does not record anything for a claim on a task whose due did not move", async () => {
    // An ordinary scheduled run the webhook picked up: no occurrence was
    // consumed by a tick, so there is nothing to give back.
    const after = await tickOver(webhookClaimed(), {
      lastSeenDue: { sweep: "2026-08-03T08:00:00" },
    });
    expect(after.triggeredRestore).toEqual({});
  });
});

describe("the human-facing progress marker", () => {
  /**
   * A comment saying "running now", posted on claim and removed on release.
   * Purely informational: nothing decides from it, because two mechanisms
   * tracking one piece of state is the shape of every defect found on
   * 2026-08-01. Found again by a sentinel in its first line rather than by a
   * stored id, so a lost state file cannot orphan it.
   */
  async function tickWith(task: Task, outcome: TransportResult["outcome"] | null, seed = {}) {
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-poller-"));
    const stateFile = pathJoin(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify(seed));

    const comment = vi.fn().mockResolvedValue(undefined);
    const deleteComment = vi.fn().mockResolvedValue(undefined);
    const provider = {
      listOpen: vi.fn().mockResolvedValue([task]),
      setLabels: vi.fn().mockResolvedValue(undefined),
      setDue: vi.fn().mockResolvedValue(undefined),
      comment,
      listComments: vi.fn().mockResolvedValue([
        { id: "c1", content: "**RUNNING** since 2026-08-01 09:00 UTC — dispatched." },
        { id: "c2", content: "an unrelated note the user wrote" },
      ]),
      deleteComment,
    } as never;

    try {
      await tick({
        provider,
        transport: outcome ? fakeTransport(outcome) : null,
        prober: null,
        autoDispatch: true,
        dryRun: false,
        now: NOW,
        stateFile,
      });
      return { comment, deleteComment };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("posts the marker when a dispatch lands", async () => {
    const { comment } = await tickWith(dueTask(), "queued");
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0]![1]).toContain("**RUNNING**");
  });

  it("removes it again when the dispatch did not land", async () => {
    // The claim is released on failure, so the marker must go with it.
    const { comment, deleteComment } = await tickWith(dueTask(), "unreachable");
    expect(comment).not.toHaveBeenCalled();
    expect(deleteComment).toHaveBeenCalledWith("c1");
  });

  it("removes it on completion and leaves other comments alone", async () => {
    const finished: Task = {
      ...dueTask(),
      due: "2026-08-03T08:00:00Z", // advanced = the run ended
      labels: [RUNNING_LABEL],
    };
    const { deleteComment } = await tickWith(finished, null, {
      startedAt: { sweep: NOW - 60_000 },
    });
    expect(deleteComment).toHaveBeenCalledWith("c1");
    expect(deleteComment).not.toHaveBeenCalledWith("c2");
  });
});
