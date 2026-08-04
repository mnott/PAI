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

  /**
   * The case above only proves the guard rejects a date that is wholly in the
   * past, which an end-of-day comparison also does. The slot that actually bit
   * was TODAY's, already elapsed by the clock: on 2026-08-04 a 09:00 daily was
   * restored at 09:30 and then re-dispatched every two ticks for the rest of
   * the day. Both spellings of the time appear because restoreDueString emits
   * either, depending on whether the rule already carries one.
   */
  it("does not write back today's slot once its time of day has passed", async () => {
    for (const entry of [
      "every day at 08:00 starting 2026-08-01", // NOW is 12:00Z on that date
      "every day at 9am starting 2026-08-01",
    ]) {
      const { setDue } = await completeOnce({ sweep: entry });
      expect(setDue, entry).not.toHaveBeenCalled();
    }
  });

  it("still writes back today's slot when its time is yet to come", async () => {
    const entry = "every day at 20:00 starting 2026-08-01";
    const { setDue } = await completeOnce({ sweep: entry });
    expect(setDue).toHaveBeenCalledWith("sweep", entry);
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

describe("a restore entry does not outlive its run", () => {
  /**
   * triggeredRestore was only ever consumed on the completion path, so a run
   * ended any other way — abandoned, or released by hand — left the entry
   * behind. It then fired on that task's NEXT completion, whenever that came.
   *
   * Observed 2026-08-02: entries from runs ended by hand the previous night
   * fired on the first unattended 08:00 completion and wrote the due date from
   * 08-03 back to 08-02. Already past, so the task was instantly overdue and
   * the following tick would have dispatched a duplicate sweep.
   */
  function sweepTask(labels: string[] = []): Task {
    return {
      id: "sweep",
      title: "Job sweep",
      body: "",
      owner: { project: "jobs-matthias", rootPath: "/j", source: "label" },
      due: "2026-08-03T08:00:00",
      recurrence: "every day at 08:00",
      priority: "p4",
      labels,
    };
  }

  async function tickOrphan(task: Task, seed: Record<string, unknown>) {
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-orphan-"));
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
        provider,
        transport: null,
        prober: null,
        autoDispatch: false,
        dryRun: false,
        now: NOW,
        stateFile,
        webhookActive: true,
      });
      return JSON.parse(readFileSync(stateFile, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const ENTRY = "every day at 08:00 starting 2026-08-02";

  it("drops an entry whose run is no longer claimed by anyone", async () => {
    const after = await tickOrphan(sweepTask(), {
      triggeredRestore: { sweep: ENTRY },
      lastSeenDue: { sweep: "2026-08-03T08:00:00" },
    });
    expect(after.triggeredRestore.sweep).toBeUndefined();
  });

  it("keeps an entry while the task is still claimed", async () => {
    // Liveness is the RUNNING label, not our own startedAt: a webhook-triggered
    // run is claimed before this poller ever sees it, so keying on startedAt
    // would discard exactly the entries the webhook path depends on.
    const after = await tickOrphan(sweepTask([RUNNING_LABEL]), {
      triggeredRestore: { sweep: ENTRY },
      lastSeenDue: { sweep: "2026-08-03T08:00:00" },
    });
    expect(after.triggeredRestore.sweep).toBe(ENTRY);
  });

  it("keeps an entry for a run this poller itself started", async () => {
    const after = await tickOrphan(sweepTask(), {
      startedAt: { sweep: NOW - 60_000 },
      triggeredRestore: { sweep: ENTRY },
      lastSeenDue: { sweep: "2026-08-03T08:00:00" },
    });
    expect(after.triggeredRestore.sweep).toBe(ENTRY);
  });
});


/**
 * A scheduled task that cannot route.
 *
 * The failure this pins is not "the task did not run" — it is that nothing
 * said so. The daily check logged "unrouted — cannot dispatch" 151 times over
 * two days into /tmp/pai-scheduler.log while reading, in the tracker, as
 * "recurring, every day at 9am". A human found it, not this code.
 *
 * The discriminator is the due date, and it is load-bearing in BOTH directions:
 * an unrouted task WITH one has promised to run and broken that promise, while
 * an unrouted task WITHOUT one is the findings inbox at rest. Alarming on the
 * second would bury the first.
 */
describe("unrouted scheduled tasks", () => {
  const notify = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    notify.mockClear();
    vi.doMock("../notifications/router.js", () => ({ routeNotification: notify }));
  });

  function unroutedTask(due: string | null): Task {
    return {
      id: "daily",
      title: "Daily check: WhatsApp, machine health, background jobs",
      body: "",
      // Exactly what resolveOwner returns for a task sitting at the bus root.
      owner: { project: null, rootPath: null, source: "none", rawHint: "Mail & Identity" },
      due,
      priority: "p2",
      labels: [],
    };
  }

  async function tickUnrouted(task: Task, seed: Record<string, unknown> = {}) {
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-unrouted-"));
    const stateFile = pathJoin(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify(seed));
    const provider = {
      listOpen: vi.fn().mockResolvedValue([task]),
      setLabels: vi.fn().mockResolvedValue(undefined),
      setDue: vi.fn().mockResolvedValue(undefined),
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
        webhookActive: true,
      });
      return { report, state: JSON.parse(readFileSync(stateFile, "utf-8")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reports a due unrouted task as stuck", async () => {
    // Was 0 before: the one dispatch failure that retrying can never fix was
    // also the only one that did not raise an alarm.
    const { report } = await tickUnrouted(unroutedTask("2026-08-01T09:00:00Z"));
    expect(report.stuck).toBe(1);
  });

  it("says in the note which container failed to match", async () => {
    const { report } = await tickUnrouted(unroutedTask("2026-08-01T09:00:00Z"));
    const notes = report.decisions.map((d) => d.note).join("\n");
    expect(notes).toContain("unrouted");
    expect(notes).toContain("Mail & Identity");
  });

  it("records that it alarmed, so the next tick stays quiet", async () => {
    const { state } = await tickUnrouted(unroutedTask("2026-08-01T09:00:00Z"));
    expect(state.alarmedAt.daily).toBe(NOW);
  });

  it("does not alarm twice inside the quiet window", async () => {
    // launchd runs this every 15 minutes. Alarming each time is how an alarm
    // becomes noise and stops being read at all.
    const { report } = await tickUnrouted(unroutedTask("2026-08-01T09:00:00Z"), {
      alarmedAt: { daily: NOW - 60_000 },
    });
    expect(report.stuck).toBe(1); // still reported...
    expect(notify).not.toHaveBeenCalled(); // ...but not sent again
  });

  it("alarms again once the quiet window has passed", async () => {
    const { state } = await tickUnrouted(unroutedTask("2026-08-01T09:00:00Z"), {
      alarmedAt: { daily: NOW - 25 * 60 * 60 * 1000 },
    });
    expect(state.alarmedAt.daily).toBe(NOW);
  });

  it("stays silent about an undated unrouted task", async () => {
    // The findings inbox. UNROUTED is its normal resting state — a finding
    // carries no date and promises nothing, so there is no broken promise to
    // report. This is the case that makes the alarm above worth reading.
    const { report, state } = await tickUnrouted(unroutedTask(null));
    expect(report.stuck).toBe(0);
    expect(state.alarmedAt.daily).toBeUndefined();
  });
});

/**
 * Guard for the test above, not for the code.
 *
 * "notify was not called" passes just as happily when the mock was never wired
 * to the dynamic import at all — a vacuous green that would hide the whole
 * escalation being dead. This pins the positive case so the negative one means
 * something.
 */
describe("the alarm actually reaches the notification router", () => {
  it("calls routeNotification for a due unrouted task", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    vi.resetModules();
    vi.doMock("../notifications/router.js", () => ({ routeNotification: notify }));
    vi.doMock("../daemon/config.js", () => ({ loadConfig: () => ({ notifications: {} }) }));

    const { tick: freshTick } = await import("./poller.js");
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-notify-"));
    const stateFile = pathJoin(dir, "state.json");
    writeFileSync(stateFile, "{}");
    try {
      await freshTick({
        provider: {
          listOpen: vi.fn().mockResolvedValue([
            {
              id: "daily",
              title: "Daily check",
              body: "",
              owner: { project: null, rootPath: null, source: "none" },
              due: "2026-08-01T09:00:00Z",
              priority: "p2",
              labels: [],
            },
          ]),
          setLabels: vi.fn().mockResolvedValue(undefined),
          setDue: vi.fn().mockResolvedValue(undefined),
          comment: vi.fn().mockResolvedValue(undefined),
        } as never,
        transport: null,
        prober: null,
        autoDispatch: true,
        dryRun: false,
        now: NOW,
        stateFile,
        webhookActive: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.doUnmock("../notifications/router.js");
      vi.doUnmock("../daemon/config.js");
      vi.resetModules();
    }

    expect(notify).toHaveBeenCalledTimes(1);
    const [payload] = notify.mock.calls[0];
    expect(payload.event).toBe("error");
    expect(payload.message).toContain("no owner");
    // Asserting the tail of the sentence was not enough. The head of it was
    // `"${task.content}"`, a field the Task type does not have, so every alarm
    // v0.27.0 ever sent named the task `undefined` — and this test passed
    // throughout. An alarm that cannot say which task it is about is barely an
    // alarm, so the identity is now pinned separately from the explanation.
    expect(payload.message).toContain("Daily check");
    expect(payload.message).not.toContain("undefined");
  });
});

/**
 * Parking: the state between "failed" and "gave up".
 *
 * `failedDispatches` counted attempts and gated the alarm, but never gated the
 * RETRY. On 2026-08-04 a task owned by a project whose directory had been
 * renamed months earlier opened a fresh terminal window every fifteen minutes
 * for nine hours: each attempt spawned a tab, failed its `cd`, waited out the
 * full 90s readiness timeout, and changed nothing before the next one.
 *
 * These pin both halves of the bargain. A parked task stops being launched at
 * something that cannot accept it — and keeps saying so, because a task that
 * silently stops running is the failure this whole subsystem exists to prevent.
 */
describe("parking a task that cannot be dispatched", () => {
  const notify = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    notify.mockClear();
    vi.doMock("../notifications/router.js", () => ({ routeNotification: notify }));
  });

  function failingTransport(outcome: TransportResult["outcome"], reason?: string): Transport {
    return { dispatch: vi.fn().mockResolvedValue({ outcome, reason, session: "jobs-matthias" }) };
  }

  async function tickWith(transport: Transport | null, seed: Record<string, unknown> = {}, task = dueTask()) {
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-parked-"));
    const stateFile = pathJoin(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify(seed));
    const provider = {
      listOpen: vi.fn().mockResolvedValue([task]),
      setLabels: vi.fn().mockResolvedValue(undefined),
      setDue: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    } as never;
    try {
      const report = await tick({
        provider,
        transport,
        prober: null,
        autoDispatch: true,
        dryRun: false,
        now: NOW,
        stateFile,
        webhookActive: true,
      });
      return { report, state: JSON.parse(readFileSync(stateFile, "utf-8")), transport };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const MISSING_ROOT = "project_root_missing: /Users/x/old-name which does not exist";

  it("parks a missing project root on the FIRST failure", async () => {
    // Not on the third. Two further attempts buy nothing here and cost two
    // terminal windows and three minutes of spawn timeout apiece.
    const { report, state } = await tickWith(failingTransport("unlaunchable", MISSING_ROOT));
    expect(state.parked.sweep).toBeDefined();
    expect(report.decisions[0]!.note).toContain("PARKED");
    expect(report.decisions[0]!.note).toContain("permanent failure");
  });

  it("does not launch anything for an already-parked task", async () => {
    // The whole point: no tab, no 90s timeout, no fifteen-minute repeat.
    const transport = failingTransport("unlaunchable", MISSING_ROOT);
    await tickWith(transport, {
      parked: { sweep: { reason: MISSING_ROOT, at: NOW - 3_600_000, due: dueTask().due } },
    });
    expect(transport.dispatch).not.toHaveBeenCalled();
  });

  it("keeps reporting a parked task as stuck", async () => {
    // Parked must not mean forgotten. The 2026-08-01 daily check was invisible
    // precisely because nothing counted it.
    const { report } = await tickWith(failingTransport("unlaunchable", MISSING_ROOT), {
      parked: { sweep: { reason: MISSING_ROOT, at: NOW - 3_600_000, due: dueTask().due } },
    });
    expect(report.stuck).toBe(1);
  });

  it("does not count a parked task as dispatched", async () => {
    // `dispatched: 1, stuck: 1` would read as a launch that went wrong, when
    // nothing was launched at all.
    const { report } = await tickWith(failingTransport("unlaunchable", MISSING_ROOT), {
      parked: { sweep: { reason: MISSING_ROOT, at: NOW - 3_600_000, due: dueTask().due } },
    });
    expect(report.dispatched).toBe(0);
  });

  it("keeps alarming daily while parked, rather than once and never again", async () => {
    const { state } = await tickWith(failingTransport("unlaunchable", MISSING_ROOT), {
      parked: { sweep: { reason: MISSING_ROOT, at: NOW - 3_600_000, due: dueTask().due } },
      alarmedAt: { sweep: NOW - 25 * 60 * 60 * 1000 },
    });
    expect(state.alarmedAt.sweep).toBe(NOW);
  });

  it("stays quiet inside the 24h window even though it reports every tick", async () => {
    const { report, state } = await tickWith(failingTransport("unlaunchable", MISSING_ROOT), {
      parked: { sweep: { reason: MISSING_ROOT, at: NOW - 3_600_000, due: dueTask().due } },
      alarmedAt: { sweep: NOW - 60_000 },
    });
    expect(report.stuck).toBe(1); // still counted...
    expect(state.alarmedAt.sweep).toBe(NOW - 60_000); // ...not re-sent
  });

  it("unparks when the due date moves, because that is the user acting", async () => {
    // Rescheduling is the release gesture: it needs no command to remember, and
    // it is what a user does anyway once the cause is fixed. Without it,
    // parking would be a one-way door that quietly retires a task.
    const transport = failingTransport("delivered");
    const { state } = await tickWith(transport, {
      parked: { sweep: { reason: MISSING_ROOT, at: NOW - 3_600_000, due: "2026-07-01T09:00:00Z" } },
    });
    expect(transport.dispatch).toHaveBeenCalled();
    expect(state.parked.sweep).toBeUndefined();
  });

  it("still gives an ordinary failure its three attempts", async () => {
    // Sessions that are briefly busy, an iTerm mid-launch, a loaded machine —
    // all resolve on their own. Parking those on first contact would turn a
    // transient blip into a task that stops running until a human notices.
    const { report, state } = await tickWith(failingTransport("unreachable", "session is busy"));
    expect(state.parked.sweep).toBeUndefined();
    expect(report.decisions[0]!.note).toContain("not dispatched (1/3)");
  });

  it("parks a task whose project directory is gone, before spawning anything", async () => {
    // The 2026-08-04 incident, in its real shape. AIBroker does not report the
    // directory as missing — it opens the tab, the `cd` fails, Claude never
    // starts, and 90 seconds later it says `unreachable — Launched a session in
    // <path> but it did not become ready within 90s`. Nothing in that sentence
    // can be matched for "missing", so the guard has to ask the disk instead.
    //
    // `transport.dispatch` not being called is the assertion that matters: the
    // cost being avoided is the terminal window and the 90-second wait, and a
    // guard that parked only AFTER the attempt would save neither.
    const transport = failingTransport(
      "unreachable",
      "Launched a session in /nope/gone but it did not become ready within 90s."
    );
    const gone: Task = {
      ...dueTask(),
      owner: { project: "jobs-grazyna", rootPath: "/nope/gone", source: "label" },
    };
    const { report, state } = await tickWith(transport, {}, gone);
    expect(transport.dispatch).not.toHaveBeenCalled();
    expect(state.parked.sweep?.reason).toContain("/nope/gone");
    expect(report.decisions[0]!.note).toContain("PARKED");
    expect(report.stuck).toBe(1);
  });

  it("dispatches normally when the project directory is there", async () => {
    // Guard for the test above: "did not dispatch" would pass just as happily
    // if the check rejected every task, which would silently park everything.
    const transport = failingTransport("delivered");
    const { state } = await tickWith(transport); // fixture rootPath is /tmp
    expect(transport.dispatch).toHaveBeenCalled();
    expect(state.parked.sweep).toBeUndefined();
  });

  it("names the parked task in the alarm it sends", async () => {
    await tickWith(failingTransport("unlaunchable", MISSING_ROOT));
    expect(notify).toHaveBeenCalled();
    const [payload] = notify.mock.calls[0]!;
    expect(payload.message).toContain("Jobs Matthias sweep");
    expect(payload.message).not.toContain("undefined");
  });
});

/**
 * The alarm's own last resort.
 *
 * routeNotification reports which channels worked, and escalate() used to throw
 * that away. On 2026-08-04 the WhatsApp provider was dialling /tmp/whazaa.sock,
 * a socket that stopped existing when Whazaa became a thin adapter, so `error`
 * events failed silently: four escalations about a sweep that had not run in
 * nine hours reached /tmp/pai-scheduler.log and nowhere else.
 *
 * The tracker is the one channel that cannot be misconfigured out of existence,
 * because it is where the task already lives.
 */
describe("an alarm nobody could deliver falls back to the tracker", () => {
  const dueUnrouted = [
    {
      id: "daily",
      title: "Daily check",
      body: "",
      owner: { project: null, rootPath: null, source: "none" },
      due: "2026-08-01T09:00:00Z",
      priority: "p2",
      labels: [],
    },
  ];

  async function runWith(routeResult: unknown) {
    vi.resetModules();
    vi.doMock("../notifications/router.js", () => ({
      routeNotification: vi.fn().mockResolvedValue(routeResult),
    }));
    vi.doMock("../daemon/config.js", () => ({ loadConfig: () => ({ notifications: {} }) }));

    const { tick: freshTick } = await import("./poller.js");
    const dir = mkdtempSync(pathJoin(tmpdir(), "pai-fallback-"));
    const stateFile = pathJoin(dir, "state.json");
    writeFileSync(stateFile, "{}");
    const comment = vi.fn().mockResolvedValue(undefined);
    try {
      await freshTick({
        provider: {
          listOpen: vi.fn().mockResolvedValue(dueUnrouted),
          setLabels: vi.fn().mockResolvedValue(undefined),
          setDue: vi.fn().mockResolvedValue(undefined),
          comment,
        } as never,
        transport: null,
        prober: null,
        autoDispatch: true,
        dryRun: false,
        now: NOW,
        stateFile,
        webhookActive: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.doUnmock("../notifications/router.js");
      vi.doUnmock("../daemon/config.js");
    }
    return comment;
  }

  it("comments on the task when every channel failed", async () => {
    const comment = await runWith({
      channelsAttempted: ["whatsapp"],
      channelsSucceeded: [],
      channelsFailed: ["whatsapp"],
      mode: "auto",
    });
    expect(comment).toHaveBeenCalled();
    const [taskId, text] = comment.mock.calls[0];
    // The task is named by WHERE the comment lands, not by repeating its title
    // into the body — this is posted on the task itself.
    expect(taskId).toBe("daily");
    expect(text).toContain("scheduled task cannot run");
    expect(text).toContain("no notification channel accepted");
  });

  it("stays quiet when a channel did deliver", async () => {
    const comment = await runWith({
      channelsAttempted: ["whatsapp"],
      channelsSucceeded: ["whatsapp"],
      channelsFailed: [],
      mode: "auto",
    });
    const fallback = comment.mock.calls.find((c) =>
      String(c[1]).includes("no notification channel accepted")
    );
    expect(fallback).toBeUndefined();
  });
});
