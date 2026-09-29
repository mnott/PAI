import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { elapsedOf, isLive, longestSleepSecs, nowStamp, ownsPid } from "./status.js";

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

describe("elapsedOf", () => {
  const base = new Date("2026-09-23T07:33:00Z");
  it("returns unparseable as ?", () => {
    expect(elapsedOf("not-a-timestamp", base)).toBe("?");
  });
  it("formats 0 seconds as 0s", () => {
    expect(elapsedOf("2026-09-23T07:33:00Z", base)).toBe("0s");
  });
  it("formats 59 seconds as 59s", () => {
    const ts = new Date(base.getTime() - 59 * 1000).toISOString();
    expect(elapsedOf(ts, base)).toBe("59s");
  });
  it("formats 60 seconds as 1m 00s", () => {
    const ts = new Date(base.getTime() - 60 * 1000).toISOString();
    expect(elapsedOf(ts, base)).toBe("1m 00s");
  });
  it("formats 83 seconds as 1m 23s", () => {
    const ts = new Date(base.getTime() - 83 * 1000).toISOString();
    expect(elapsedOf(ts, base)).toBe("1m 23s");
  });
  it("formats 3599 seconds as 59m 59s", () => {
    const ts = new Date(base.getTime() - 3599 * 1000).toISOString();
    expect(elapsedOf(ts, base)).toBe("59m 59s");
  });
  it("formats 3725 seconds as 1h 02m 05s", () => {
    const ts = new Date(base.getTime() - 3725 * 1000).toISOString();
    expect(elapsedOf(ts, base)).toBe("1h 02m 05s");
  });
});

describe("longestSleepSecs", () => {
  it("catches a long sleep standing alone or leading a compound command", () => {
    expect(longestSleepSecs("sleep 590")).toBe(590);
    expect(longestSleepSecs("sleep 2m")).toBe(120);
  });

  it("catches a long sleep buried after &&, ;, |, &, a newline, do/then, (, {, $(", () => {
    expect(longestSleepSecs("cd x && sleep 300")).toBe(300);
    expect(longestSleepSecs("sleep 120; tail -5 f")).toBe(120);
    expect(longestSleepSecs("while true; do sleep 90; done")).toBe(90);
    expect(longestSleepSecs("for i in 1 2; do sleep 61; done")).toBe(61);
    expect(longestSleepSecs("true || sleep 90")).toBe(90);
    expect(longestSleepSecs("make build | sleep 90")).toBe(90);
    expect(longestSleepSecs("make build &\nsleep 90")).toBe(90);
    expect(longestSleepSecs("(sleep 90)")).toBe(90);
    expect(longestSleepSecs("{ sleep 90; }")).toBe(90);
    expect(longestSleepSecs("echo $(sleep 90)")).toBe(90);
  });

  it("returns the LONGEST qualifying segment, not the first", () => {
    expect(longestSleepSecs("sleep 65; sleep 590")).toBe(590);
    expect(longestSleepSecs("sleep 590; sleep 65")).toBe(590);
  });

  it("allows sleeps under the floor and non-sleep lookalikes", () => {
    expect(longestSleepSecs("sleep 30")).toBeNull();
    expect(longestSleepSecs("sleep 59; tail f")).toBeNull();
    expect(longestSleepSecs("echo sleep 500")).toBeNull();
    expect(longestSleepSecs("grep sleep file")).toBeNull();
    expect(longestSleepSecs("cat '/tmp/sleep 300.txt'")).toBeNull();
    expect(longestSleepSecs("timeout 600 make")).toBeNull();
    expect(longestSleepSecs("")).toBeNull();
  });
});
