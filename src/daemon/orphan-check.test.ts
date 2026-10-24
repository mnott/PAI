import { describe, expect, it } from "vitest";
import { checkOrphans, currentOrphanWarning, orphanWarning } from "./orphan-check.js";

describe("orphan check", () => {
  it("stays quiet at or below 1 % and when there are no chunks", () => {
    expect(orphanWarning({ orphaned: 10, total: 1000 })).toBeNull();
    expect(orphanWarning({ orphaned: 0, total: 0 })).toBeNull();
  });
  it("warns above 1 % with the repair command", () => {
    expect(orphanWarning({ orphaned: 2_790_000, total: 3_544_000 })?.message).toBe("orphaned chunks: 2790000 — run `pai memory repair-orphans`");
  });
  it("logs loudly and keeps the warning for the cockpit; clears when repaired", async () => {
    const lines: string[] = [];
    await checkOrphans(async () => ({ orphaned: 50, total: 100 }), (l) => lines.push(l));
    expect(lines[0]).toContain("WARNING orphaned chunks: 50");
    expect(currentOrphanWarning()?.orphaned).toBe(50);
    await checkOrphans(async () => ({ orphaned: 0, total: 100 }), (l) => lines.push(l));
    expect(currentOrphanWarning()).toBeNull();
    expect(lines).toHaveLength(1);
  });
});
