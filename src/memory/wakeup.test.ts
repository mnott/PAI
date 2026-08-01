import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildL1EssentialStory } from "./wakeup.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-wakeup-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Write a session note into `Notes/YYYY/MM/`, the layout PAI actually uses.
 * The body carries a Work Done section because that is what L1 extracts.
 */
function writeNote(
  year: string,
  month: string,
  filename: string,
  marker: string
): void {
  const dir = join(root, "Notes", year, month);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    ["# Session", "", "## Work Done", "", `- [x] ${marker}`, ""].join("\n"),
    "utf8"
  );
}

describe("buildL1EssentialStory — note ordering", () => {
  /**
   * The regression this guards. Note numbers restart per month directory and
   * after a registry merge renumbers a project, so the highest number is not
   * the most recent note. Observed live on 2026-08-01: a five-month-old
   * `0184 - 2026-02-22` outranked that day's `0008 - 2026-08-01`, and a
   * resumed session was handed February material as its recent history.
   */
  it("prefers the most recent DATE over the highest note number", () => {
    writeNote("2026", "02", "0184 - 2026-02-22 - Coogle Fresh Session.md", "FEBRUARY");
    writeNote("2026", "08", "0008 - 2026-08-01 - Voiceink Tcc Permission.md", "AUGUST");

    const story = buildL1EssentialStory(root);

    expect(story).toContain("AUGUST");
    expect(story.indexOf("AUGUST")).toBeLessThan(story.indexOf("FEBRUARY"));
    expect(story).toContain("[2026-08-01 - Voiceink Tcc Permission]");
  });

  it("breaks ties within one day by note number", () => {
    writeNote("2026", "08", "0002 - 2026-08-01 - Early.md", "EARLY");
    writeNote("2026", "08", "0008 - 2026-08-01 - Late.md", "LATE");

    const story = buildL1EssentialStory(root);
    expect(story.indexOf("LATE")).toBeLessThan(story.indexOf("EARLY"));
  });

  it("sorts undated notes last instead of letting them win", () => {
    writeNote("2026", "08", "0008 - 2026-08-01 - Dated.md", "DATED");
    writeNote("2026", "08", "0999 - Undated Legacy Note.md", "UNDATED");

    const story = buildL1EssentialStory(root);
    expect(story).toContain("DATED");
    expect(story.indexOf("DATED")).toBeLessThan(story.indexOf("UNDATED"));
  });

  it("returns empty when the project has no notes", () => {
    expect(buildL1EssentialStory(root)).toBe("");
  });
});
