import { describe, it, expect } from "vitest";
import { dueField } from "./todoist.js";

describe("dueField", () => {
  it("sends strict ISO as due_date, untouched by the parser", () => {
    // Already unambiguous, and Todoist's natural-language parser is
    // locale-sensitive — no reason to route this through it.
    expect(dueField("2026-08-02")).toEqual({ due_date: "2026-08-02" });
  });

  it("sends natural language as due_string", () => {
    // Reported 2026-08-01: these were sent as due_date and came back HTTP 400,
    // while --help promised "ISO or natural language".
    expect(dueField("tomorrow")).toEqual({ due_string: "tomorrow" });
    expect(dueField("next monday")).toEqual({ due_string: "next monday" });
  });

  it("sends recurrence as due_string — the case that made routines impossible", () => {
    // Recurrence is only expressible through due_string. Without it there is no
    // way to create a self-rescheduling trigger task at all.
    expect(dueField("every day")).toEqual({ due_string: "every day" });
    expect(dueField("every morning")).toEqual({ due_string: "every morning" });
    expect(dueField("every monday at 9")).toEqual({ due_string: "every monday at 9" });
  });

  it("omits the field entirely when there is no due value", () => {
    // Must be absent, not null: writing the due field at all can clear an
    // existing recurrence.
    expect(dueField(undefined)).toEqual({});
    expect(dueField(null)).toEqual({});
    expect(dueField("")).toEqual({});
    expect(dueField("   ")).toEqual({});
  });

  it("does not mistake a partial or malformed date for ISO", () => {
    // These must reach the parser rather than 400 against due_date.
    expect(dueField("2026-08")).toEqual({ due_string: "2026-08" });
    expect(dueField("Aug 2 2026")).toEqual({ due_string: "Aug 2 2026" });
    expect(dueField("2026-08-02T10:00")).toEqual({ due_string: "2026-08-02T10:00" });
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(dueField("  2026-08-02  ")).toEqual({ due_date: "2026-08-02" });
    expect(dueField("  every day ")).toEqual({ due_string: "every day" });
  });
});
