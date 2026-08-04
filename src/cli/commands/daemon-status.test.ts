/**
 * What `pai daemon status` says when the daemon is stuck.
 *
 * The regression these pin is not a crash. During the July outage every one of
 * these calls returned successfully and printed a status that read as healthy:
 * "Daemon running / Index: idle", for two days, while the queue grew and no
 * session note was written. So the assertions are about what the output
 * *contains* — an absent line is the whole failure mode.
 */

import { describe, it, expect } from "vitest";
import { formatStorageHealth } from "./daemon-status.js";

const NOW = Date.parse("2026-07-28T12:00:00Z");
const outage = (overrides: Partial<Parameters<typeof formatStorageHealth>[0]["backendOutage"] & object> = {}) => ({
  backend: "postgres",
  since: NOW - 36 * 60_000,
  attempts: 144,
  lastError: "connection refused",
  ...overrides,
});

const text = (s: Parameters<typeof formatStorageHealth>[0]) =>
  formatStorageHealth(s, NOW).map((l) => l.text).join("\n");

describe("a healthy daemon says nothing", () => {
  it("prints no health lines when the backend answers and the queue is drained", () => {
    expect(
      formatStorageHealth(
        { backendOutage: null, workQueue: { pending: 0, processing: 0, completed: 42, failed: 0, total: 42 } },
        NOW
      )
    ).toEqual([]);
  });

  it("prints nothing when the daemon sent no health fields at all", () => {
    // An older daemon against a newer CLI. Silence is right — inventing
    // "queue: 0 pending" from a missing field would be a confident wrong answer.
    expect(formatStorageHealth({}, NOW)).toEqual([]);
  });
});

describe("an outage is reported, and reported first", () => {
  it("names the backend, how long, and how many attempts", () => {
    const out = text({ backendOutage: outage(), workQueue: { pending: 0, total: 0 } });
    expect(out).toContain("BACKEND DOWN: postgres unreachable for 36 min");
    expect(out).toContain("144 attempts — connection refused");
  });

  it("leads with the outage, not with the queue", () => {
    const lines = formatStorageHealth(
      { backendOutage: outage(), workQueue: { pending: 7, total: 7 } },
      NOW
    );
    expect(lines[0]!.severity).toBe("error");
    expect(lines[0]!.text).toContain("BACKEND DOWN");
  });

  it("switches to hours once minutes stop being readable", () => {
    const twoDays = outage({ since: NOW - 48 * 60 * 60_000 });
    expect(text({ backendOutage: twoDays })).toContain("unreachable for 48.0 h");
  });

  it("says the stall is the consequence, so idle is not read as fine", () => {
    expect(text({ backendOutage: outage() })).toContain(
      "Indexing, session notes and the work queue are stalled"
    );
  });
});

describe("queue depth — the number that was collected and never printed", () => {
  it("reports the backlog during an outage", () => {
    expect(text({ backendOutage: outage(), workQueue: { pending: 12, processing: 1, total: 13 } })).toContain(
      "Work queue:  12 pending, 1 processing"
    );
  });

  it("reports a depth of zero during an outage", () => {
    // Zero is informative here: it rules the backlog out as the reason nothing
    // is moving, which is a different diagnosis from a queue of twelve.
    expect(text({ backendOutage: outage(), workQueue: { pending: 0, total: 0 } })).toContain(
      "Work queue:  0 pending"
    );
  });

  it("reports a backlog even with the backend answering", () => {
    // A queue that is not draining while the backend is up is its own bug — the
    // worker is wedged rather than blocked — and status must not hide it just
    // because there is no outage to hang it on.
    const lines = formatStorageHealth(
      { backendOutage: null, workQueue: { pending: 9, processing: 0, total: 9 } },
      NOW
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("9 pending");
    expect(lines[0]!.severity).toBe("warn");
  });

  it("treats exhausted-retry failures as an error, outage or not", () => {
    // These will never be retried. Nothing else in the status output mentions
    // them, so if this line is missing the work is simply gone in silence.
    const lines = formatStorageHealth(
      { backendOutage: null, workQueue: { pending: 0, processing: 0, failed: 3, total: 3 } },
      NOW
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.severity).toBe("error");
    expect(lines[0]!.text).toContain("3 failed");
  });

  it("omits processing and failed when they are zero", () => {
    expect(text({ backendOutage: null, workQueue: { pending: 4, processing: 0, failed: 0, total: 4 } })).toBe(
      "Work queue:  4 pending"
    );
  });
});
