import { describe, expect, it } from "vitest";
import { fmtAge, fmtSeenLocal } from "./fmt-age.js";

const H = 3_600_000;

describe("fmtAge", () => {
  it("worker pending: days from 48h, no months", () => {
    const o = { dayAfterHours: 48 };
    expect(fmtAge(5 * 60_000, o)).toBe("5m");
    expect(fmtAge(30 * H, o)).toBe("30h");
    expect(fmtAge(47 * H, o)).toBe("47h");
    expect(fmtAge(48 * H, o)).toBe("2d");
    expect(fmtAge(100 * 24 * H, o)).toBe("100d");
  });
  it("session scan: days from 24h, months from 30d", () => {
    const o = { dayAfterHours: 24, months: true };
    expect(fmtAge(59 * 60_000, o)).toBe("59m");
    expect(fmtAge(23 * H, o)).toBe("23h");
    expect(fmtAge(24 * H, o)).toBe("1d");
    expect(fmtAge(29 * 24 * H, o)).toBe("29d");
    expect(fmtAge(65 * 24 * H, o)).toBe("2mo");
  });
});

describe("fmtSeenLocal", () => {
  // Fixed instants so the assertions hold in any timezone.
  const now = new Date(2026, 9, 23, 5, 55, 0).getTime(); // 2026-10-23 05:55 local
  const d = (y: number, mo: number, day: number, h: number, min: number) =>
    new Date(y, mo - 1, day, h, min, 0).toISOString();

  it("today: time only with a minute age", () => {
    expect(fmtSeenLocal(d(2026, 10, 23, 5, 53), now)).toBe("05:53 (2 min ago)");
  });
  it("today: hour age once past an hour", () => {
    expect(fmtSeenLocal(d(2026, 10, 23, 4, 55), now)).toBe("04:55 (1 h ago)");
  });
  it("late same day still counts as today", () => {
    // 23:57 local vs. 23:59 local: same local date, so time-only.
    const late = new Date(2026, 9, 23, 23, 59, 0).getTime();
    expect(fmtSeenLocal(d(2026, 10, 23, 23, 57), late)).toBe("23:57 (2 min ago)");
  });
  it("older than today: date and time with an hour age", () => {
    expect(fmtSeenLocal(d(2026, 10, 22, 21, 44), now)).toBe("2026-10-22 21:44 (8 h ago)");
  });
  it("a future stamp clamps the age to 0 min", () => {
    expect(fmtSeenLocal(d(2026, 10, 23, 6, 0), now)).toBe("06:00 (0 min ago)");
  });
});
