import { describe, expect, it } from "vitest";
import { judgeHandover, type ContextHandoverCache } from "./context-handover-cache.js";

const cache = (generatedAt: string): ContextHandoverCache => ({
  sessionId: "s", cwd: "/x", threshold: "refresh", generatedAt, model: "sonnet", summary: "h",
});

describe("judgeHandover", () => {
  const now = Date.parse("2026-10-12T12:18:00Z");
  it("none: says generation failed", () => {
    const v = judgeHandover(null, null, now);
    expect(v.fresh).toBe(false);
    expect(v.label).toContain("failed or never ran");
  });
  it("fresh: after previous compaction and recent", () => {
    expect(judgeHandover(cache("2026-10-12T11:50:00Z"), "2026-10-12T09:00:00Z", now).fresh).toBe(true);
  });
  it("stale: before previous compaction", () => {
    const v = judgeHandover(cache("2026-10-11T19:47:57Z"), "2026-10-11T19:50:00Z", now);
    expect(v.fresh).toBe(false);
    expect(v.label).toContain("STALE");
  });
  it("stale: after previous compaction but 16h old (the 2026-10-11 case)", () => {
    const v = judgeHandover(cache("2026-10-11T19:47:57Z"), "2026-10-11T19:14:51Z", now);
    expect(v.fresh).toBe(false);
    expect(v.label).toContain("age 17h");
  });
});
