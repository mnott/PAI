import { describe, expect, it } from "vitest";

process.env.TZ = "Europe/Zurich";

const { ledgerStamp, parseStamp } = await import("./ledger.js");
const { ageMs } = await import("./supervision.js");

describe("stamps across the autumn DST switch (Europe/Zurich)", () => {
  const cest = new Date("2026-10-25T00:30:00Z");
  const cet = new Date("2026-10-25T01:30:00Z");

  it("carries the UTC offset for the same wall clock", () => {
    expect(ledgerStamp(cest)).toBe("2026-10-25 02:30:00+02:00");
    expect(ledgerStamp(cet)).toBe("2026-10-25 02:30:00+01:00");
  });

  it("parses back to the original instant", () => {
    expect(parseStamp(ledgerStamp(cest))).toBe(cest.getTime());
    expect(parseStamp(ledgerStamp(cet))).toBe(cet.getTime());
  });

  it("ages a stamp written 1 min earlier by 60 s, not 61 min", () => {
    const now = new Date("2026-10-25T01:27:25Z");
    const written = ledgerStamp(new Date(now.getTime() - 60_000));
    expect(ageMs(written, now)).toBe(60_000);
  });

  it("still parses an old zone-less stamp as local time", () => {
    expect(parseStamp("2026-10-25 02:27:25")).toBe(new Date(2026, 9, 25, 2, 27, 25).getTime());
  });
});

describe("ps start times", () => {
  it("reads etime without a zone", async () => {
    const { parseEtime, processStartMs } = await import("./proc-start.js");
    expect(parseEtime("00:05")).toBe(5);
    expect(parseEtime(" 01:02:03")).toBe(3723);
    expect(parseEtime("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseEtime("junk")).toBeNaN();
    const t = processStartMs(process.pid)!;
    expect(Math.abs(Date.now() - process.uptime() * 1000 - t)).toBeLessThan(3000);
  });

  it("picks the right hour of the repeated one from the elapsed time", async () => {
    const { resolveStart } = await import("./proc-start.js");
    const first = new Date("2026-10-25T00:30:00Z").getTime(); // 02:30 CEST
    const second = first + 3_600_000; // 02:30 CET
    const lstart = "Sun Oct 25 02:30:00 2026";
    expect(resolveStart(lstart, 600, second + 600_000)).toBe(second);
    expect(resolveStart(lstart, 4200, second + 600_000)).toBe(first);
    expect(resolveStart(lstart, NaN)).toBe(new Date(2026, 9, 25, 2, 30, 0).getTime());
    expect(resolveStart("junk", 5)).toBeUndefined();
  });
});
