import { describe, it, expect } from "vitest";
import { formatContext, isNoiseEntry } from "./inject-observations.js";

function row(id: number, title: string, minutesAgo = 0) {
  return {
    id,
    session_id: `s${id}`,
    project_id: 1,
    project_slug: "pai",
    type: "discovery",
    title,
    narrative: null,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

describe("isNoiseEntry", () => {
  it("flags Ran: and MCP: prefixed titles", () => {
    expect(isNoiseEntry("Ran: ls -la")).toBe(true);
    expect(isNoiseEntry("MCP: memory_search")).toBe(true);
    expect(isNoiseEntry("Modified foo.ts")).toBe(false);
  });
});

describe("formatContext", () => {
  it("caps the timeline at 6 entries and drops noise entries", () => {
    const observations = [
      ...Array.from({ length: 10 }, (_, i) => row(i, `Ran: cmd ${i}`)),
      ...Array.from({ length: 8 }, (_, i) => row(100 + i, `Modified file${i}.ts`)),
    ];
    const context = formatContext("pai", observations);
    const timelineLines = context
      .split("\n")
      .filter(l => l.startsWith("- ["));
    expect(timelineLines).toHaveLength(6);
    expect(timelineLines.every(l => !l.includes("Ran:"))).toBe(true);
  });

  it("falls back to unfiltered entries when fewer than 3 non-noise entries remain", () => {
    const observations = [
      row(1, "Ran: cmd 1"),
      row(2, "Ran: cmd 2"),
      row(3, "Modified file.ts"),
    ];
    const context = formatContext("pai", observations);
    const timelineLines = context.split("\n").filter(l => l.startsWith("- ["));
    expect(timelineLines).toHaveLength(3);
  });

  it("truncates each timeline line to 80 characters", () => {
    const longTitle = "Modified " + "x".repeat(200) + ".ts";
    const context = formatContext("pai", [row(1, longTitle)]);
    const timelineLine = context.split("\n").find(l => l.startsWith("- ["))!;
    expect(timelineLine.length).toBeLessThanOrEqual(80);
  });
});
