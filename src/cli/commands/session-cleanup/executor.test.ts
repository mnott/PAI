/**
 * A cleanup tool must not be able to destroy a session note.
 *
 * On 2026-08-03 this deleted four TITLED notes from one project — "Cocoapods
 * Bootstrap", "Youdrill Tools Pipeline Review" and two others — while
 * renumbering 38 others correctly. They were recoverable only because that
 * session inspected the diff before committing. Anywhere this ran and was
 * committed, they are gone with no trace that anything was removed.
 *
 * The classifier is the proximate cause: EMPTY is `sizeBytes < 400 ||
 * isTemplateOnly`, and size is a poor proxy for worthlessness — a real session
 * that produced three lines and a good title is under 400 bytes. But the fix is
 * not a better threshold. No threshold deserves to be trusted with an
 * irreversible operation, so the module now moves notes to `.archive/` and does
 * not import a delete primitive at all.
 *
 * This test reads the source because that is where the guarantee lives: the
 * property is "this module cannot delete", and the cheapest honest way to hold
 * a future edit to it is to fail the build when the primitive comes back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "executor.ts"),
  "utf8"
);

describe("the cleanup executor cannot delete notes", () => {
  it("does not import a filesystem delete primitive", () => {
    expect(source).not.toMatch(/\bunlinkSync\b/);
    expect(source).not.toMatch(/\brmSync\b/);
    expect(source).not.toMatch(/\brm\(/);
  });

  it("archives instead, into a directory that survives the run", () => {
    expect(source).toContain(".archive");
    expect(source).toMatch(/renameSync\(/);
  });

  it("does not clobber an existing archived note of the same name", () => {
    // Two "New Session.md" notes retired on different days must both survive.
    expect(source).toMatch(/existsSync\(dest\)/);
  });

  it("still deletes the session ROW, which is a cache and not the record", () => {
    // The note on disk is the artefact; the DB row is derived and rebuildable.
    // Keeping this asserted makes the asymmetry deliberate rather than accidental.
    expect(source).toMatch(/DELETE FROM sessions WHERE id = \?/);
  });
});
