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
