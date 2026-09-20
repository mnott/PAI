import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildL1EssentialStory, loadL0Identity, migrateIdentityFile } from "./wakeup.js";

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

describe("buildL1EssentialStory — cross-note deduplication", () => {
  /**
   * A daemon sometimes writes the same summary bullets into more than one
   * note. Without dedup, identical lines were emitted once per note that
   * carried them.
   */
  it("emits a bullet shared by two notes only once, while keeping each note's unique bullets", () => {
    const dir = join(root, "Notes", "2026", "08");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "0001 - 2026-08-01 - First.md"),
      [
        "# Session",
        "",
        "## Work Done",
        "",
        "- [x] Shared bullet one",
        "- [x] Shared bullet two",
        "",
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(dir, "0002 - 2026-08-02 - Second.md"),
      [
        "# Session",
        "",
        "## Work Done",
        "",
        "- [x] Shared bullet one",
        "- [x] Shared bullet two",
        "- [x] Unique bullet from second note",
        "",
      ].join("\n"),
      "utf8"
    );

    const story = buildL1EssentialStory(root);

    expect(story.split("Shared bullet one").length - 1).toBe(1);
    expect(story.split("Shared bullet two").length - 1).toBe(1);
    expect(story).toContain("Unique bullet from second note");
  });
});

describe("migrateIdentityFile", () => {
  it("reports nothing to migrate when the legacy file is absent", () => {
    const legacy = join(root, "legacy", "identity.txt");
    const target = join(root, "new", "identity.txt");

    const r = migrateIdentityFile({ from: legacy, to: target });

    expect(r.fromPath).toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  it("dry run leaves both the source and target untouched", () => {
    const legacy = join(root, "legacy", "identity.txt");
    const target = join(root, "new", "identity.txt");
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(legacy, "I am the user.", "utf8");

    const r = migrateIdentityFile({ dryRun: true, from: legacy, to: target });

    expect(r.dryRun).toBe(true);
    expect(r.fromPath).toBe(legacy);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(legacy)).toBe(true);
  });

  it("migrates the legacy file to the new location and renames the source aside", () => {
    const legacy = join(root, "legacy", "identity.txt");
    const target = join(root, "new", "identity.txt");
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(legacy, "I am the user.", "utf8");

    const r = migrateIdentityFile({ from: legacy, to: target });

    expect(r.fromPath).toBe(legacy);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("I am the user.");
    expect(existsSync(legacy)).toBe(false);
  });

  it("reports already-migrated on a second run", () => {
    const legacy = join(root, "legacy", "identity.txt");
    const target = join(root, "new", "identity.txt");
    mkdirSync(join(root, "legacy"), { recursive: true });
    mkdirSync(join(root, "new"), { recursive: true });
    writeFileSync(legacy, "I am the user.", "utf8");
    writeFileSync(target, "I am the user.", "utf8");

    const r = migrateIdentityFile({ from: legacy, to: target });

    expect(r.fromPath).toBe(legacy);
    expect(r.note).toContain("identical");
    expect(readFileSync(target, "utf8")).toBe("I am the user.");
  });
});

describe("loadL0Identity", () => {
  it("prefers the new PAI_HOME path over the legacy path", () => {
    const legacy = join(root, "legacy", "identity.txt");
    const newPath = join(root, "new", "identity.txt");
    mkdirSync(join(root, "legacy"), { recursive: true });
    mkdirSync(join(root, "new"), { recursive: true });
    writeFileSync(legacy, "LEGACY IDENTITY", "utf8");
    writeFileSync(newPath, "NEW IDENTITY", "utf8");

    expect(loadL0Identity({ newPath, legacyPath: legacy })).toBe("NEW IDENTITY");
  });

  it("falls back to the legacy path when the new path does not exist", () => {
    const legacy = join(root, "legacy", "identity.txt");
    const newPath = join(root, "new", "identity.txt");
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(legacy, "LEGACY IDENTITY", "utf8");

    expect(loadL0Identity({ newPath, legacyPath: legacy })).toBe("LEGACY IDENTITY");
  });

  it("returns empty when neither path exists", () => {
    const legacy = join(root, "legacy", "identity.txt");
    const newPath = join(root, "new", "identity.txt");

    expect(loadL0Identity({ newPath, legacyPath: legacy })).toBe("");
  });
});
