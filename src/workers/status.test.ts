import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isLive, nowStamp, ownsPid } from "./status.js";

/** This test process's own `ps` start time, formatted as `saveStatus` would. */
function ownStartedStamp(): string {
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
  return nowStamp(new Date(out));
}

describe("ownsPid", () => {
  it("is true for this process's own pid with its real start time", () => {
    expect(ownsPid({ pid: process.pid, started: ownStartedStamp() })).toBe(true);
  });

  it("is false for a live pid whose recorded start time is far off", () => {
    expect(ownsPid({ pid: process.pid, started: "2020-01-01 00:00:00" })).toBe(false);
  });

  it("is false for pid 0 or negative, without checking ps", () => {
    expect(ownsPid({ pid: 0, started: nowStamp() })).toBe(false);
    expect(ownsPid({ pid: -1, started: nowStamp() })).toBe(false);
  });

  it("is false for a pid that almost certainly does not exist", () => {
    expect(ownsPid({ pid: 999999, started: nowStamp() })).toBe(false);
  });
});

describe("isLive", () => {
  it("is true only when state is running and the pid is still owned", () => {
    const started = ownStartedStamp();
    expect(isLive({ pid: process.pid, started, state: "running" })).toBe(true);
    expect(isLive({ pid: process.pid, started, state: "done" })).toBe(false);
    expect(isLive({ pid: process.pid, started: "2020-01-01 00:00:00", state: "running" })).toBe(
      false
    );
  });
});
