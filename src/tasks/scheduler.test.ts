/**
 * Scheduler state-machine tests.
 *
 * `decide` is pure and takes its clock as input, so every case below is exact
 * rather than timing-dependent. The behaviours encoded here were measured
 * against the live Todoist API first — see the notes in scheduler.ts.
 */

import { describe, it, expect } from "vitest";
import {
  decide,
  dispatchOrder,
  expectedMinutes,
  overdueMinutes,
  skipIfLateMinutes,
  isRunning,
  RUNNING_LABEL,
  EMPTY_RUN_STATE,
  DEFAULT_EXPECTED_MINUTES,
  expectedAdvanceDays,
  wasTicked,
  restoreDueString,
} from "./scheduler.js";
import type { Task } from "./types.js";

const NOW = Date.parse("2026-08-01T12:00:00Z");

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Jobs Matthias sweep",
    body: "",
    owner: { project: "jobs-matthias", rootPath: "/tmp", source: "label" },
    due: "2026-08-01T09:00:00Z",
    priority: "p2",
    labels: [],
    ...over,
  };
}

describe("overdue arithmetic", () => {
  it("counts minutes past the due time", () => {
    expect(overdueMinutes(task(), NOW)).toBe(180);
  });

  it("is negative for a future task", () => {
    expect(overdueMinutes(task({ due: "2026-08-01T18:00:00Z" }), NOW)).toBe(-360);
  });

  it("treats a date-only due as the start of that day", () => {
    expect(overdueMinutes(task({ due: "2026-08-01" }), NOW)).toBeGreaterThan(0);
  });
});

describe("catch-up policy", () => {
  it("defaults to running however late", () => {
    expect(skipIfLateMinutes(task())).toBeNull();
    expect(decide(task(), { now: NOW, state: EMPTY_RUN_STATE }).action).toBe("dispatch");
  });

  it("parses hour and minute windows", () => {
    expect(skipIfLateMinutes(task({ labels: ["pai-skip-if-late:4h"] }))).toBe(240);
    expect(skipIfLateMinutes(task({ labels: ["pai-skip-if-late:90m"] }))).toBe(90);
  });

  it("skips a task overdue past its window", () => {
    // 3h overdue, 2h window
    const d = decide(task({ labels: ["pai-skip-if-late:2h"] }), { now: NOW, state: EMPTY_RUN_STATE });
    expect(d.action).toBe("skip");
  });

  it("still runs when inside the window", () => {
    const d = decide(task({ labels: ["pai-skip-if-late:4h"] }), { now: NOW, state: EMPTY_RUN_STATE });
    expect(d.action).toBe("dispatch");
  });
});

describe("completion detection", () => {
  it("treats an advanced due date as completion, not a closed task", () => {
    // The measured Todoist behaviour: a recurring task rolls forward and is
    // immediately unchecked, so 'closed' never fires.
    const t = task({ labels: [RUNNING_LABEL], due: "2026-08-02T09:00:00Z" });
    const d = decide(t, {
      now: NOW,
      state: { startedAt: { t1: NOW - 20 * 60_000 }, failedProbes: {} },
    });
    expect(d.action).toBe("complete");
    if (d.action === "complete") expect(d.durationMinutes).toBe(20);
  });

  it("does NOT report completion for a claim it cannot account for", () => {
    // This used to return "complete", which was wrong once the claim stopped
    // being ours alone. AIBroker's webhook claims and dispatches on the user
    // ticking the box — and that tick advances the due date before the run
    // starts, so a perfectly healthy webhook run looks exactly like this. The
    // old rule reported it finished on the next tick and stripped the interlock
    // mid-run; confirmed against a live probe on 2026-08-01.
    const t = task({ labels: [RUNNING_LABEL], due: "2026-08-02T09:00:00Z" });
    const d = decide(t, { now: NOW, state: EMPTY_RUN_STATE });
    expect(d.action).toBe("orphaned");
  });

  it("reports completion for someone else's run once the due date advances again", () => {
    // The real end signal for a run we did not start: a SECOND advance, seen
    // while we were already watching the claim.
    const t = task({ labels: [RUNNING_LABEL], due: "2026-08-04T08:00:00Z" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-03T08:00:00Z" },
      claimSeenAt: { t1: NOW - 30 * 60_000 },
    });
    expect(d.action).toBe("complete");
    if (d.action === "complete") expect(d.durationMinutes).toBeNull();
  });

  it("does not mistake the trigger's own advance for a completion", () => {
    // First tick after the webhook claimed it: the due date HAS advanced, but
    // that advance is the tick that caused the dispatch, not an ending. Told
    // apart by never having seen the claim before.
    const t = task({ labels: [RUNNING_LABEL], due: "2026-08-03T08:00:00Z" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-02T08:00:00Z" },
      claimSeenAt: {},
    });
    expect(d.action).not.toBe("complete");
  });

  it("ages out a foreign claim instead of holding the interlock forever", () => {
    const t = task({ labels: [RUNNING_LABEL], due: "2026-08-03T08:00:00Z" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      claimSeenAt: { t1: NOW - 301 * 60_000 },
    });
    expect(d.action).toBe("abandoned");
  });

  it("does not probe a session it did not dispatch to", () => {
    const t = task({ labels: [RUNNING_LABEL], due: "2026-08-03T08:00:00Z" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      claimSeenAt: { t1: NOW - 60 * 60_000 },
    });
    expect(d.action).toBe("running");
  });
});

describe("in-flight handling", () => {
  it("leaves a run alone inside its expected duration", () => {
    const t = task({ labels: [RUNNING_LABEL] });
    const d = decide(t, {
      now: NOW,
      state: { startedAt: { t1: NOW - 10 * 60_000 }, failedProbes: {} },
    });
    expect(d.action).toBe("running");
  });

  it("probes once the run exceeds expected x1.5", () => {
    const t = task({ labels: [RUNNING_LABEL] });
    // default expected 30m -> probe at 45m
    const d = decide(t, {
      now: NOW,
      state: { startedAt: { t1: NOW - 46 * 60_000 }, failedProbes: {} },
    });
    expect(d.action).toBe("probe");
    if (d.action === "probe") expect(d.expectedMinutes).toBe(DEFAULT_EXPECTED_MINUTES);
  });

  it("uses a learned duration instead of the default", () => {
    const t = task({ labels: [RUNNING_LABEL] });
    // learned 60m -> probe at 90m, so 70m in is still just running
    const d = decide(t, {
      now: NOW,
      state: { startedAt: { t1: NOW - 70 * 60_000 }, failedProbes: {} },
      history: { t1: [58, 60, 62] },
    });
    expect(d.action).toBe("running");
  });

  it("probes rather than re-dispatching when the start time is unknown", () => {
    // The dangerous case: labelled running, no record. Re-dispatching blind
    // could double-run a sweep.
    const t = task({ labels: [RUNNING_LABEL] });
    const d = decide(t, { now: NOW, state: EMPTY_RUN_STATE });
    expect(d.action).toBe("orphaned");
  });
});

describe("duration learning", () => {
  it("falls back when there is no history", () => {
    expect(expectedMinutes([])).toBe(DEFAULT_EXPECTED_MINUTES);
  });

  it("averages the last five runs", () => {
    expect(expectedMinutes([10, 20, 30])).toBe(20);
  });

  it("ignores runs older than the last five", () => {
    expect(expectedMinutes([999, 10, 10, 10, 10, 10])).toBe(10);
  });

  it("discards non-positive measurements", () => {
    expect(expectedMinutes([0, -5, 20, 20])).toBe(20);
  });
});

describe("ordering", () => {
  it("runs higher priority first, then oldest due", () => {
    const a = task({ id: "a", priority: "p3", due: "2026-08-01T08:00:00Z" });
    const b = task({ id: "b", priority: "p1", due: "2026-08-01T11:00:00Z" });
    const c = task({ id: "c", priority: "p3", due: "2026-08-01T07:00:00Z" });
    expect(dispatchOrder([a, b, c]).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("label detection", () => {
  it("is case-insensitive", () => {
    expect(isRunning(task({ labels: ["PAI-Running"] }))).toBe(true);
    expect(isRunning(task({ labels: ["something-else"] }))).toBe(false);
  });
});

describe("recurrence periods", () => {
  it("recognises the common rules", () => {
    expect(expectedAdvanceDays("every day at 08:00")).toEqual([1]);
    expect(expectedAdvanceDays("every other day")).toEqual([2]);
    expect(expectedAdvanceDays("every 3 days")).toEqual([3]);
    expect(expectedAdvanceDays("every monday at 09:00")).toEqual([7]);
    expect(expectedAdvanceDays("every 2 weeks")).toEqual([14]);
    expect(expectedAdvanceDays("every month")).toEqual([28, 29, 30, 31]);
  });

  it("allows a weekday rule to skip a weekend", () => {
    expect(expectedAdvanceDays("every workday")).toEqual([1, 2, 3]);
  });

  it("returns null for a one-off and for rules it does not know", () => {
    expect(expectedAdvanceDays(null)).toBeNull();
    expect(expectedAdvanceDays("every 3rd friday of the month")).toBeNull();
  });
});

describe("hand-ticked detection", () => {
  const daily = { recurrence: "every day at 08:00" };

  it("reads a one-period jump as a completed occurrence", () => {
    const t = task({ ...daily, due: "2026-08-03T08:00:00" });
    expect(wasTicked(t, "2026-08-02T08:00:00")).toBe(true);
  });

  it("reads an off-cadence jump as a reschedule, not a trigger", () => {
    // Dragging tomorrow's sweep to Friday must not fire a sweep — and must not
    // have the date silently put back underneath the user.
    const t = task({ ...daily, due: "2026-08-05T08:00:00" });
    expect(wasTicked(t, "2026-08-02T08:00:00")).toBe(false);
  });

  it("never triggers on a non-recurring task", () => {
    // Completing a one-off closes it; it leaves the open list rather than
    // reappearing later, so a forward jump can only be a reschedule.
    const t = task({ recurrence: null, due: "2026-08-03T08:00:00" });
    expect(wasTicked(t, "2026-08-02T08:00:00")).toBe(false);
  });

  it("never triggers without a previous observation", () => {
    // First tick after install: every date is new, nothing has moved.
    expect(wasTicked(task(daily), undefined)).toBe(false);
  });

  it("ignores a date moving backwards", () => {
    const t = task({ ...daily, due: "2026-08-01T08:00:00" });
    expect(wasTicked(t, "2026-08-02T08:00:00")).toBe(false);
  });

  it("believes an unrecognised recurrence rather than staying silent", () => {
    const t = task({ recurrence: "every 3rd friday", due: "2026-08-22T08:00:00" });
    expect(wasTicked(t, "2026-08-01T08:00:00")).toBe(true);
  });
});

describe("schedule restoration", () => {
  it("carries the rule and the date in one string", () => {
    expect(restoreDueString("every day at 08:00", "2026-08-02T08:00:00")).toBe(
      "every day at 08:00 starting 2026-08-02"
    );
  });

  it("adds the time when the rule does not carry one", () => {
    // "every day starting 2026-08-02" would come back as a date-only occurrence
    // and quietly drop the 08:00 the routine actually runs at.
    expect(restoreDueString("every day", "2026-08-02T08:00:00")).toBe(
      "every day at 08:00 starting 2026-08-02"
    );
  });

  it("leaves a date-only task without a time", () => {
    expect(restoreDueString("every day", "2026-08-02")).toBe("every day starting 2026-08-02");
  });
});

describe("the checkbox as a trigger", () => {
  const daily = { recurrence: "every day at 08:00" };

  it("dispatches now and puts a future occurrence back", () => {
    const t = task({ ...daily, due: "2026-08-03T08:00:00" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-02T08:00:00" },
    });
    expect(d.action).toBe("triggered");
    if (d.action === "triggered") {
      expect(d.restoreTo).toBe("every day at 08:00 starting 2026-08-02");
    }
  });

  it("does not restore an occurrence that has already passed", () => {
    // Ticked at 12:00 on a task that was due at 09:00: that occurrence is the
    // one this run satisfies, so putting it back would only make the task look
    // late the instant it is written.
    const t = task({ ...daily, due: "2026-08-02T09:00:00Z" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-01T09:00:00Z" },
    });
    expect(d.action).toBe("triggered");
    if (d.action === "triggered") expect(d.restoreTo).toBeNull();
  });

  it("does not re-trigger while the run it started is still marked running", () => {
    // The session completes the task itself, which advances the date again. If
    // the running branch did not short-circuit, that advance would read as a
    // second hand-tick and dispatch the same sweep twice.
    const t = task({ ...daily, labels: [RUNNING_LABEL], due: "2026-08-03T08:00:00" });
    const d = decide(t, {
      now: NOW,
      state: { startedAt: { t1: NOW - 60_000 }, failedProbes: {} },
      lastSeenDue: { t1: "2026-08-02T08:00:00" },
    });
    expect(d.action).toBe("complete");
  });
});

describe("abandoning a stale claim", () => {
  /**
   * The running label is an interlock now: AIBroker's webhook skips any task
   * carrying it. Nothing here removed it except a completion, so a session that
   * died mid-turn left the task claimed forever and NEITHER dispatcher would
   * ever run it again. Permanent silence beats a duplicate run as a failure, so
   * an old claim is released on elapsed time alone.
   */
  const running = { labels: [RUNNING_LABEL] };

  it("releases a claim older than the limit", () => {
    // Default expected 30m, factor 10 -> 300m.
    const d = decide(task(running), {
      now: NOW,
      state: { startedAt: { t1: NOW - 301 * 60_000 }, failedProbes: {} },
    });
    expect(d.action).toBe("abandoned");
    if (d.action === "abandoned") expect(d.thresholdMinutes).toBe(300);
  });

  it("still only probes an ordinary overrun", () => {
    const d = decide(task(running), {
      now: NOW,
      state: { startedAt: { t1: NOW - 60 * 60_000 }, failedProbes: {} },
    });
    expect(d.action).toBe("probe");
  });

  it("applies a floor so a short learned duration is not released early", () => {
    // Learned 5m would give a 50m limit; the floor holds it at 120m.
    const d = decide(task(running), {
      now: NOW,
      state: { startedAt: { t1: NOW - 60 * 60_000 }, failedProbes: {} },
      history: { t1: [5, 5, 5] },
    });
    expect(d.action).toBe("probe");

    const later = decide(task(running), {
      now: NOW,
      state: { startedAt: { t1: NOW - 121 * 60_000 }, failedProbes: {} },
      history: { t1: [5, 5, 5] },
    });
    expect(later.action).toBe("abandoned");
    if (later.action === "abandoned") expect(later.thresholdMinutes).toBe(120);
  });

  it("prefers completion over abandonment when the due date advanced", () => {
    // A very slow run that DID finish must be recorded as finished, not repaired.
    const d = decide(task({ ...running, due: "2026-08-02T09:00:00Z" }), {
      now: NOW,
      state: { startedAt: { t1: NOW - 400 * 60_000 }, failedProbes: {} },
    });
    expect(d.action).toBe("complete");
  });
});

describe("a finishing webhook run is not a hand-tick", () => {
  /**
   * aibroker 0.17.4: the session that finishes a triggered run drops the claim
   * itself, then ends with `pai task done`. By the next tick the task is
   * unclaimed with its due date exactly one period on — byte-identical to
   * someone ticking the box, and it would have dispatched the same work again.
   */
  const daily = { recurrence: "every day at 08:00" };

  it("ignores the advance when the claim was being watched", () => {
    const t = task({ ...daily, due: "2026-08-04T08:00:00", labels: [] });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-03T08:00:00" },
      claimSeenAt: { t1: NOW - 40 * 60_000 },
    });
    expect(d.action).not.toBe("triggered");
  });

  it("still fires on a genuine hand-tick, which carries no claim", () => {
    const t = task({ ...daily, due: "2026-08-04T08:00:00", labels: [] });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-03T08:00:00" },
      claimSeenAt: {},
    });
    expect(d.action).toBe("triggered");
  });

  it("rejects a whole run that fitted between two ticks, on the period check", () => {
    // Never saw the claim, but the due advanced twice — once for the trigger,
    // once for the completion — so it does not match one daily period.
    const t = task({ ...daily, due: "2026-08-04T08:00:00", labels: [] });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-02T08:00:00" },
      claimSeenAt: {},
    });
    expect(d.action).not.toBe("triggered");
  });
});

describe("a live webhook takes precedence over the due-date guess", () => {
  const daily = { recurrence: "every day at 08:00" };

  /**
   * The inference reads "due advanced exactly one period, unclaimed" as a tick.
   * For a daily recurrence that is byte-identical to a human dragging the task
   * forward one day, and to the poller repairing a due date it wrote wrongly
   * itself — which is how repairing one duplicate sweep produced a second on
   * 2026-08-02. No local signal separates them; a webhook has the real event.
   */
  it("does NOT infer a trigger when a webhook is delivering completions", () => {
    const t = task({ ...daily, due: "2026-08-03T08:00:00" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-02T08:00:00" },
      webhookActive: true,
    });
    expect(d.action).not.toBe("triggered");
  });

  it("still infers when no webhook is running — the fallback must survive", () => {
    // A machine with no public endpoint has nothing else, so suppressing the
    // guess everywhere would remove the feature rather than fix it.
    const t = task({ ...daily, due: "2026-08-03T08:00:00" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-02T08:00:00" },
      webhookActive: false,
    });
    expect(d.action).toBe("triggered");
  });

  it("defaults to inferring, so an unset flag cannot silently disable it", () => {
    const t = task({ ...daily, due: "2026-08-03T08:00:00" });
    const d = decide(t, {
      now: NOW,
      state: EMPTY_RUN_STATE,
      lastSeenDue: { t1: "2026-08-02T08:00:00" },
    });
    expect(d.action).toBe("triggered");
  });
});

