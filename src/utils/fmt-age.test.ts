import { describe, expect, it } from "vitest";
import { fmtAge } from "./fmt-age.js";

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
