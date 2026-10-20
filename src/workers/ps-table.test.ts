import { describe, expect, it } from "vitest";
import { psTable, psTableOrNull, truncateLines } from "./ps-table.js";
import { realSnapshot } from "./reaper.js";
import { strayWorkerProcesses } from "./viewer.js";

const huge = (): string => {
  const rows: string[] = [];
  for (let i = 0; i < 60; i++) rows.push(`${1000 + i} 1 swift-frontend ${"x".repeat(50_000)}`);
  rows.push("4242 ttys001 node /bin/pai worker follow abc123");
  return rows.join("\n") + "\n";
};

describe("ps table", () => {
  it("fixture is over 2 MB", () => {
    expect(huge().length).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("truncates long lines and keeps short ones", () => {
    const out = psTable("pid=,command=", () => huge());
    expect(out.length).toBeLessThan(100_000);
    expect(out).toContain("worker follow abc123");
    expect(truncateLines("abcdef", 3)).toBe("abc");
  });

  it("retries then returns null when ps fails", () => {
    let n = 0;
    const r = psTableOrNull("command=", () => {
      n++;
      throw new Error("spawnSync ps ENOBUFS");
    });
    expect(r).toBeNull();
    expect(n).toBe(3);
    let m = 0;
    expect(psTableOrNull("command=", () => (++m < 2 ? (() => { throw new Error("x"); })() : "ok"))).toBe("ok");
  });

  it("reaper snapshot reads a huge table", () => {
    const table = Array.from({ length: 60 }, (_, i) => `${100 + i} 1 ${process.getuid?.() ?? 0} 0.0 01:00 ${"y".repeat(50_000)}`).join("\n");
    expect(realSnapshot(() => table).length).toBe(60);
  });

  it("stray scan accepts a truncated huge table", () => {
    const out = psTable("pid=,command=", () => huge());
    expect(() => strayWorkerProcesses([], out)).not.toThrow();
  });
});
