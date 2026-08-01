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

  it("reports completion even when the start time was lost", () => {
    const t = task({ labels: [RUNNING_LABEL], due: "2026-08-02T09:00:00Z" });
    const d = decide(t, { now: NOW, state: EMPTY_RUN_STATE });
    expect(d.action).toBe("complete");
    if (d.action === "complete") expect(d.durationMinutes).toBeNull();
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
