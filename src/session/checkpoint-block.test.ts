import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContinueBlock,
  locateContinue,
  stripContinue,
  applyContinue,
  appendCheckpointToNote,
  parseMarker,
  readContinueCheckpoint,
  MARKER_CLOSE,
} from "./checkpoint-block.js";

const TS = "2026-08-01T13:35:00.000Z";
const SESSION = "0003 - 2026-08-01 - Task Bus And Scheduler";
const UUID = "d840b282-7fc1-4cf6-b51e-8a951f6d88e6";

/**
 * A body that would have broken the old heuristic scanner: it contains both a
 * `---` rule and `##` headings, either of which the pre-marker parser treated
 * as the end of the ## Continue section.
 */
const RICH_BODY = [
  "Shipped PAI 0.13.0 → 0.15.0, all published, tree clean.",
  "",
  "## Open decisions",
  "",
  "- Whether the daily check needs an owner",
  "- Whether to create the tasks",
  "",
  "---",
  "",
  "## Watch",
  "",
  "- Whisper trim: two rules changed at once, so a regression won't be attributable.",
].join("\n");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-checkpoint-test-"));
  mkdirSync(join(root, "Notes"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTodo(content: string): string {
  const p = join(root, "Notes", "TODO.md");
  writeFileSync(p, content, "utf8");
  return p;
}

function readTodo(): string {
  return readFileSync(join(root, "Notes", "TODO.md"), "utf8");
}

// ---------------------------------------------------------------------------

describe("buildContinueBlock", () => {
  it("records authorship, session line, uuid and timestamp in the marker", () => {
    const block = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      sessionId: UUID,
      cwd: "/tmp/proj",
      body: "Did the thing.",
      timestamp: TS,
    });

    const meta = parseMarker(block.split("\n").find((l) => l.includes("pai:checkpoint"))!);
    expect(meta).toEqual({
      authored: "model",
      session: SESSION,
      sessionId: UUID,
      ts: TS,
    });
  });

  it("carries the resume handle — the reason the uuid is recorded at all", () => {
    const block = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      sessionId: UUID,
      cwd: "/tmp/proj",
      body: "x",
      timestamp: TS,
    });
    expect(block).toContain(`claude --resume ${UUID}`);
  });

  it("includes the body verbatim", () => {
    const block = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      cwd: "/tmp/proj",
      body: RICH_BODY,
      timestamp: TS,
    });
    expect(block).toContain("Whisper trim: two rules changed at once");
    expect(block).toContain("## Open decisions");
  });

  it("says so explicitly when there is no body", () => {
    const block = buildContinueBlock({
      authored: "auto",
      sessionLine: SESSION,
      cwd: "/tmp/proj",
      timestamp: TS,
    });
    expect(block).toContain("No checkpoint body was recorded");
  });
});

// ---------------------------------------------------------------------------

describe("locateContinue", () => {
  it("uses the close marker, so a body containing --- and ## survives", () => {
    const block = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      cwd: "/tmp/proj",
      body: RICH_BODY,
      timestamp: TS,
    });
    const doc = block + "## Infrastructure\n\nRest of the file.\n";

    const found = locateContinue(doc);
    expect(found).not.toBeNull();
    expect(found!.meta?.authored).toBe("model");

    // The section must end at the close marker, not at the first --- inside
    // the body — otherwise the rest of the body leaks into the document.
    const lines = doc.split("\n");
    expect(lines.slice(found!.startIdx, found!.endIdx).join("\n")).toContain(
      MARKER_CLOSE
    );

    const remainder = stripContinue(doc);
    expect(remainder).toContain("## Infrastructure");
    expect(remainder).not.toContain("Whisper trim");
    expect(remainder).not.toContain("## Open decisions");
  });

  it("falls back to the legacy heuristic for unmarked blocks", () => {
    const doc = [
      "## Continue",
      "",
      "> **Last session:** 0002 - 2026-08-01 - Old",
      "",
      "---",
      "",
      "## Infrastructure",
      "",
      "Rest.",
    ].join("\n");

    const found = locateContinue(doc);
    expect(found).not.toBeNull();
    expect(found!.meta).toBeNull();
    expect(stripContinue(doc)).toBe("## Infrastructure\n\nRest.");
  });

  it("returns null when there is no ## Continue section", () => {
    expect(locateContinue("# Title\n\nBody.\n")).toBeNull();
  });

  it("does not swallow the file when the close marker is missing", () => {
    const doc = [
      "## Continue",
      "",
      '<!-- pai:checkpoint authored="model" session="x" ts="y" -->',
      "",
      "> truncated, no close marker",
      "",
      "---",
      "",
      "## Infrastructure",
    ].join("\n");

    expect(stripContinue(doc)).toContain("## Infrastructure");
  });
});

// ---------------------------------------------------------------------------

describe("applyContinue — preservation", () => {
  it("an auto write does NOT clobber an authored checkpoint for the same session", () => {
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      sessionId: UUID,
      cwd: root,
      body: RICH_BODY,
      timestamp: TS,
    });

    // This is what session-stop.sh runs on every clean exit.
    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      cwd: root,
    });

    expect(result.action).toBe("preserved");
    expect(readTodo()).toContain("Whisper trim: two rules changed at once");
    expect(readTodo()).toContain(`claude --resume ${UUID}`);
  });

  it("an auto write DOES replace an authored checkpoint from an earlier session", () => {
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      cwd: root,
      body: RICH_BODY,
      timestamp: TS,
    });

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0004 - 2026-08-02 - A Later Session",
      cwd: root,
      body: "Recent prompts and working tree for the later session.",
    });

    expect(result.action).toBe("written");
    expect(readTodo()).toContain("0004 - 2026-08-02 - A Later Session");
    // The slot changes hands; the handover does not evaporate. This assertion
    // read `not.toContain("Whisper trim")` until 2026-08-04, which is to say
    // the destruction was pinned as the intended behaviour — and it held for
    // exactly as long as it took a live session to lose a real handover to it.
    // Taking the slot and keeping the text were never in conflict.
    expect(readTodo()).toContain("Whisper trim");
    expect(result.archived).toBe(true);
  });

  it("a bodyless auto write does NOT replace an earlier session's real handover", () => {
    // Observed live on 2026-08-01 in the AIBroker project: the stop hook wrote a
    // metadata-only checkpoint over a real one, deferring to a session note that
    // was never created. The next session resumed with nothing and had to ask
    // the user what they had been working on. A write with no content does not
    // get to destroy content, even when it is about a newer session.
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      cwd: root,
      body: RICH_BODY,
      timestamp: TS,
    });

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0015 - 2026-08-01 - Audit Trail Concurrency Fix V0130",
      sessionId: "91f7a040-15f6-4139-8452-da0436e5859f",
      cwd: root,
    });

    expect(result.action).toBe("preserved");
    expect(readTodo()).toContain("Whisper trim: two rules changed at once");
    expect(readTodo()).not.toContain("No checkpoint body was recorded");
  });

  it("a bodyless auto write DOES replace a previous bodyless placeholder", () => {
    // The converse: a placeholder carries nothing worth keeping, so a later
    // bodyless write is free to refresh it and point at the current session.
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      cwd: root,
    });

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0016 - 2026-08-02 - A Later Session",
      cwd: root,
    });

    expect(result.action).toBe("written");
    expect(readTodo()).toContain("0016 - 2026-08-02 - A Later Session");
  });

  it("an authored write always replaces, including another authored one", () => {
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      cwd: root,
      body: "First checkpoint.",
      timestamp: TS,
    });

    const result = applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      cwd: root,
      body: "Second checkpoint, later in the same session.",
      timestamp: "2026-08-01T15:00:00.000Z",
    });

    expect(result.action).toBe("written");
    expect(readTodo()).toContain("Second checkpoint");
    expect(readTodo()).not.toContain("First checkpoint");
  });

  it("an auto write replaces a legacy unmarked block", () => {
    writeTodo(
      [
        "## Continue",
        "",
        "> **Last session:** 0002 - 2026-08-01 - Old",
        "",
        "---",
        "",
        "## Infrastructure",
        "",
        "Keep me.",
      ].join("\n")
    );

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      cwd: root,
    });

    expect(result.action).toBe("written");
    const out = readTodo();
    expect(out).toContain(SESSION);
    expect(out).toContain("Keep me.");
    expect(out).not.toContain("0002 - 2026-08-01 - Old");
  });

  it("carries forward hand-written state hiding under generated header lines", () => {
    // The shape a session ends up with after working around the clobbering bug
    // by hand: generic header lines on top, real state in a subsection below,
    // all inside an unmarked block. An auto write must not destroy this.
    writeTodo(
      [
        "## Continue",
        "",
        "> **Last session:** 0002 - 2026-08-01 - Old",
        "> **Paused at:** 2026-08-01T09:00:00.000Z",
        ">",
        "> Working directory: /tmp/proj",
        "",
        "### Restored state (do not delete)",
        "",
        "- Six commits pushed",
        "- OTA v1.2.1 published",
        "",
        "---",
        "",
        "## Infrastructure",
        "",
        "Keep me.",
      ].join("\n")
    );

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      cwd: root,
    });

    expect(result.action).toBe("written");
    expect(result.carriedForward).toBe(true);

    const out = readTodo();
    expect(out).toContain("OTA v1.2.1 published");
    expect(out).toContain("Six commits pushed");
    expect(out).toContain("### Restored state (do not delete)");
    expect(out).toContain("Carried forward from the previous checkpoint");
    expect(out).toContain("Keep me.");
    // The stale header line is gone; the content it was hiding is not.
    expect(out).not.toContain("0002 - 2026-08-01 - Old");
  });

  it("does not carry forward a block that is only generated header lines", () => {
    writeTodo(
      [
        "## Continue",
        "",
        "> **Last session:** 0002 - 2026-08-01 - Old",
        "> **Paused at:** 2026-08-01T09:00:00.000Z",
        ">",
        "> Working directory: /tmp/proj",
        "",
        "---",
        "",
        "## Infrastructure",
      ].join("\n")
    );

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      cwd: root,
    });

    expect(result.carriedForward).toBeFalsy();
    expect(readTodo()).not.toContain("Carried forward");
  });

  it("preserves the rest of the document across repeated writes", () => {
    writeTodo("## Continue\n\n> old\n\n---\n\n## Infrastructure\n\nKeep me.\n");

    for (let i = 0; i < 3; i++) {
      applyContinue({
        rootPath: root,
        authored: "model",
        sessionLine: SESSION,
        cwd: root,
        body: `Pass ${i}.`,
        timestamp: TS,
      });
    }

    const out = readTodo();
    expect(out).toContain("Keep me.");
    expect(out).toContain("Pass 2.");
    expect(out).not.toContain("Pass 1.");
    // Exactly one ## Continue heading — no accumulation.
    expect(out.split("## Continue").length - 1).toBe(1);
  });

  it("creates Notes/TODO.md when the project has none", () => {
    const bare = mkdtempSync(join(tmpdir(), "pai-bare-"));
    try {
      const result = applyContinue({
        rootPath: bare,
        authored: "model",
        sessionLine: SESSION,
        cwd: bare,
        body: "First ever checkpoint.",
        timestamp: TS,
      });
      expect(result.action).toBe("written");
      expect(readFileSync(join(bare, "Notes", "TODO.md"), "utf8")).toContain(
        "First ever checkpoint."
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("dry-run writes nothing", () => {
    const p = writeTodo("# TODO\n");
    const result = applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      cwd: root,
      body: "Should not land.",
      timestamp: TS,
      dryRun: true,
    });
    expect(result.action).toBe("written");
    expect(result.block).toContain("Should not land.");
    expect(readFileSync(p, "utf8")).toBe("# TODO\n");
  });
});

// ---------------------------------------------------------------------------

describe("appendCheckpointToNote", () => {
  it("appends the body under a timestamped heading", () => {
    const note = join(root, "note.md");
    writeFileSync(note, "# Session 0003\n\n## Work Done\n\nStuff.\n", "utf8");

    const { appended } = appendCheckpointToNote(note, RICH_BODY, TS);
    expect(appended).toBe(true);

    const out = readFileSync(note, "utf8");
    expect(out).toContain(`## Pause Checkpoint — ${TS}`);
    expect(out).toContain("Whisper trim");
    expect(out).toContain("Stuff.");
  });

  it("is idempotent for the same timestamp", () => {
    const note = join(root, "note.md");
    writeFileSync(note, "# Session 0003\n", "utf8");

    appendCheckpointToNote(note, "Body.", TS);
    const second = appendCheckpointToNote(note, "Body.", TS);

    expect(second.appended).toBe(false);
    const out = readFileSync(note, "utf8");
    expect(out.split("## Pause Checkpoint").length - 1).toBe(1);
  });

  it("reports an error rather than throwing on an unreadable note", () => {
    const { appended, error } = appendCheckpointToNote(
      join(root, "does-not-exist.md"),
      "Body.",
      TS
    );
    expect(appended).toBe(false);
    expect(error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Preservation keyed on the session UUID
// ---------------------------------------------------------------------------

describe("applyContinue — UUID is the preservation key", () => {
  /**
   * The live failure. `session-stop.sh` runs `session slug --apply` and
   * `session cleanup --execute` — both of which rewrite the session note
   * filename — BEFORE it runs `session handover`. So the auto write always
   * arrives with a different session line than the one `pai pause` recorded,
   * and a filename-keyed comparison destroys the checkpoint every time.
   */
  it("preserves across a note rename when the UUID matches", () => {
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: "0008 - 2026-08-01 - Voiceink Tcc Permission Issue",
      sessionId: UUID,
      cwd: root,
      body: RICH_BODY,
      timestamp: TS,
    });

    // The stop hook renamed and renumbered the note before reaching handover.
    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0007 - 2026-08-01 - Pai 0160 Release Completed",
      sessionId: UUID,
      cwd: root,
    });

    expect(result.action).toBe("preserved");
    expect(readTodo()).toContain("Whisper trim: two rules changed at once");
  });

  it("still replaces a genuinely different session even if the line matches", () => {
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      sessionId: UUID,
      cwd: root,
      body: RICH_BODY,
      timestamp: TS,
    });

    // Same derived line — numbering restarted — but a different session.
    // Carries a body, so the only thing under test is session discrimination:
    // a bodyless write is refused on content grounds before the UUID is
    // consulted at all, which would make this pass for the wrong reason.
    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: root,
      body: "Recent prompts and working tree for the genuinely different session.",
    });

    expect(result.action).toBe("written");
    // Discrimination is what is under test: a different session takes the slot.
    // Where the displaced text goes is the archive's business, asserted there.
    expect(result.archived).toBe(true);
  });

  it("falls back to the session line when the auto write has no UUID", () => {
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      sessionId: UUID,
      cwd: root,
      body: RICH_BODY,
      timestamp: TS,
    });

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      cwd: root,
    });

    expect(result.action).toBe("preserved");
  });

  it("falls back to the session line for checkpoints written without a UUID", () => {
    writeTodo("# TODO\n");

    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: SESSION,
      cwd: root,
      body: RICH_BODY,
      timestamp: TS,
    });

    const result = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: SESSION,
      sessionId: UUID,
      cwd: root,
    });

    expect(result.action).toBe("preserved");
  });
});

// ---------------------------------------------------------------------------
// readContinueCheckpoint — the delivery half of a handover
// ---------------------------------------------------------------------------

describe("readContinueCheckpoint", () => {
  it("returns the authored body and its metadata", () => {
    const doc = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      sessionId: UUID,
      cwd: "/tmp/project",
      body: RICH_BODY,
      timestamp: TS,
    });

    const read = readContinueCheckpoint(doc);
    expect(read).not.toBeNull();
    expect(read!.meta?.authored).toBe("model");
    expect(read!.meta?.session).toBe(SESSION);
    expect(read!.meta?.sessionId).toBe(UUID);
    expect(read!.meta?.ts).toBe(TS);
  });

  /**
   * The body must survive byte-for-byte. Markdown depends on its blank lines:
   * strip them and the paragraph, the heading and the table below it weld into
   * one unreadable run by the time the next session reads it.
   */
  it("returns the body byte-for-byte, blank lines and --- rules intact", () => {
    const doc = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      cwd: "/tmp/project",
      body: RICH_BODY,
      timestamp: TS,
    });

    expect(readContinueCheckpoint(doc)!.body).toBe(RICH_BODY);
  });

  it("keeps a table readable — the shape a real handover uses", () => {
    const table = [
      "### Shipped",
      "",
      "| Area | What |",
      "|---|---|",
      "| Checkpoints | body mirrored into the note |",
      "",
      "70 tests (was 39).",
    ].join("\n");

    const doc = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      cwd: "/tmp/project",
      body: table,
      timestamp: TS,
    });

    expect(readContinueCheckpoint(doc)!.body).toBe(table);
  });

  it("strips the generated header lines from the body", () => {
    const doc = buildContinueBlock({
      authored: "model",
      sessionLine: SESSION,
      cwd: "/tmp/project",
      body: "The only real content.",
      timestamp: TS,
    });

    const read = readContinueCheckpoint(doc);
    expect(read!.body).toBe("The only real content.");
    expect(read!.body).not.toContain("Last session:");
  });

  it("returns null for a bodyless auto block — nothing to hand over", () => {
    const doc = buildContinueBlock({
      authored: "auto",
      sessionLine: SESSION,
      cwd: "/tmp/project",
      timestamp: TS,
    });

    expect(readContinueCheckpoint(doc)).toBeNull();
  });

  it("returns null when there is no ## Continue section at all", () => {
    expect(readContinueCheckpoint("# TODO\n\n- [ ] something\n")).toBeNull();
  });

  it("reads an unmarked legacy block that carries real content", () => {
    const doc = [
      "## Continue",
      "",
      "> **Last session:** 0001 - 2026-07-01 - Old",
      "",
      "### Hand-placed state",
      "",
      "Worked around the clobbering bug by hand.",
      "",
      "---",
      "",
      "## Something else",
    ].join("\n");

    const read = readContinueCheckpoint(doc);
    expect(read).not.toBeNull();
    expect(read!.meta).toBeNull();
    expect(read!.body).toContain("Worked around the clobbering bug by hand.");
    // The blank line between heading and paragraph is preserved.
    expect(read!.body).toBe(
      "### Hand-placed state\n\nWorked around the clobbering bug by hand."
    );
  });

  it("does not leak the following section into the body", () => {
    const doc =
      buildContinueBlock({
        authored: "model",
        sessionLine: SESSION,
        cwd: "/tmp/project",
        body: "Checkpoint content.",
        timestamp: TS,
      }) + "\n## Infrastructure\n\nUnrelated backlog item.\n";

    const read = readContinueCheckpoint(doc);
    expect(read!.body).toBe("Checkpoint content.");
    expect(read!.body).not.toContain("Unrelated backlog item.");
  });
});

/**
 * The H1-eating bug.
 *
 * `heuristicEnd` terminated on `##` but not on `#`, so a TODO.md whose
 * `## Continue` block sits ABOVE its `# TODO` title absorbed the title into the
 * section — and every regenerate destroyed it. Three sessions reported this
 * independently on 2026-08-03; one lost the H1 three times and restored it from
 * git each time, which is the only reason anyone noticed.
 *
 * An H1 is a document-level heading and cannot belong to a level-2 section, so
 * this is a structural fact rather than a tuned heuristic.
 */
describe("an H1 terminates the Continue section", () => {
  const doc = [
    "## Continue",
    "",
    "auto checkpoint body",
    "",
    "# TODO",
    "",
    "- [ ] a real task nobody wants deleted",
    "",
  ].join("\n");

  it("does not swallow the H1 into the section", () => {
    const found = locateContinue(doc);
    expect(found).not.toBeNull();
    expect(found!.lines.join("\n")).not.toContain("# TODO");
  });

  it("leaves the H1 and everything under it in place when stripped", () => {
    const rest = stripContinue(doc);
    expect(rest).toContain("# TODO");
    expect(rest).toContain("- [ ] a real task nobody wants deleted");
  });

  it("still treats ### as a subsection rather than a terminator", () => {
    // The opposite error, and the reason the original regex was narrow.
    const withSub = ["## Continue", "", "### Restored state", "", "detail", ""].join("\n");
    const found = locateContinue(withSub);
    expect(found!.lines.join("\n")).toContain("### Restored state");
    expect(found!.lines.join("\n")).toContain("detail");
  });

  it("still terminates at the next ## heading", () => {
    const withH2 = ["## Continue", "", "body", "", "## Notes", "", "keep me", ""].join("\n");
    const rest = stripContinue(withH2);
    expect(rest).toContain("## Notes");
    expect(rest).toContain("keep me");
  });
});

/**
 * The checkpoint-clobbering data loss.
 *
 * Case 2 deliberately lets an auto write replace an authored checkpoint from an
 * EARLIER session, and that policy is right — TODO.md would otherwise freeze.
 * The bug was that identity DEGRADES and healthy sessions fell into it:
 * `sessionId` is optional on `pai pause`, so isSameSession falls back to
 * comparing a display line containing the note TITLE, and pausing renames the
 * note. A session wrote a checkpoint, its note was renamed, the hook fired
 * seconds later and no longer recognised its own work.
 *
 * Three sessions reported this independently on 2026-08-03 from one
 * `pai pause all`; one lost its checkpoint three times.
 */
describe("a fresh model checkpoint survives an auto write", () => {
  const NOW = "2026-08-03T12:00:00.000Z";

  function modelTodo(ts: string, session: string): string {
    return [
      "## Continue",
      "",
      `<!-- pai:checkpoint authored="model" session="${session}" ts="${ts}" -->`,
      "",
      "### Where this stopped",
      "",
      "Irreplaceable reasoning nobody wants flattened to a template.",
      "",
      "<!-- /pai:checkpoint -->",
      "",
      "# TODO",
      "",
      "- [ ] a real task",
      "",
    ].join("\n");
  }

  it("preserves it when the note was renamed out from under the hook", () => {
    // 90 seconds old, and the session line no longer matches — precisely the
    // reported race.
    writeTodo(modelTodo("2026-08-03T11:58:30.000Z", "0007 - 2026-08-03 - Old Title"));
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0007 - 2026-08-03 - Renamed By The Pause Itself",
      cwd: "/tmp",
      body: "mechanical digest",
      timestamp: NOW,
    });
    expect(r.action).toBe("preserved");
    expect(readTodo()).toContain("Irreplaceable reasoning");
  });

  it("keeps the H1 intact while doing so", () => {
    writeTodo(modelTodo("2026-08-03T11:58:30.000Z", "0007 - old"));
    applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0007 - renamed",
      cwd: "/tmp",
      body: "digest",
      timestamp: NOW,
    });
    expect(readTodo()).toContain("# TODO");
  });

  it("still replaces a genuinely old authored checkpoint", () => {
    // Two days old. This is the case 2 policy that stops TODO.md freezing, and
    // it must keep working — the fix is a grace window, not a veto.
    writeTodo(modelTodo("2026-08-01T12:00:00.000Z", "0003 - 2026-08-01 - Ancient"));
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0007 - 2026-08-03 - Current",
      cwd: "/tmp",
      body: "mechanical digest",
      timestamp: NOW,
    });
    expect(r.action).toBe("written");
    expect(readTodo()).toContain("mechanical digest");
  });

  it("does not treat a clock-skewed future stamp as ancient", () => {
    writeTodo(modelTodo("2026-08-03T12:05:00.000Z", "0007 - skewed"));
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0007 - renamed",
      cwd: "/tmp",
      body: "digest",
      timestamp: NOW,
    });
    expect(r.action).toBe("preserved");
  });
});

// ---------------------------------------------------------------------------
// Regression — 2026-08-04: a session that did nothing destroyed a real handover
// ---------------------------------------------------------------------------

describe("a do-nothing session cannot take the handover slot", () => {
  const NOW = "2026-08-04T06:59:08.295Z";

  /** Yesterday's autosave: authored="auto", but with real content in it. */
  function richAutoTodo(): string {
    return [
      "## Continue",
      "",
      '<!-- pai:checkpoint authored="auto" session="0037 - 2026-08-03 - Outbound Messaging" ' +
        'session-id="1b10d0c7-852b-43a4-9286-b10cab4cc4bb" ts="2026-08-04T00:26:06.963Z" -->',
      "",
      "_Automatic checkpoint — 2026-08-04T00:26:06.924Z_",
      "",
      "### What was being asked",
      "",
      "- [Session:Paperfull] Request: please open a Todoist project for Paperfull",
      "",
      "### Working tree",
      "",
      "- Branch: `main`",
      "",
      "<!-- /pai:checkpoint -->",
      "",
      "# TODO",
      "",
      "- [ ] a real task",
      "",
    ].join("\n");
  }

  /**
   * What the session-stop hook sends when it found no work items and no
   * completion message: one line that the generated header already carries.
   */
  const NOTHING_TO_SAY = "Working directory: /Users/i052341/Daten/Cloud/Development/ai/AIBroker";

  it("preserves the previous handover against a body that only restates the header", () => {
    writeTodo(richAutoTodo());
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0038 - 2026-08-04 - No Work Performed — User Exited Immediately",
      cwd: "/Users/i052341/Daten/Cloud/Development/ai/AIBroker",
      body: NOTHING_TO_SAY,
      timestamp: NOW,
    });
    expect(r.action).toBe("preserved");
    const after = readTodo();
    expect(after).toContain("Todoist project for Paperfull");
    expect(after).not.toContain("No Work Performed");
  });

  it("treats a multi-line header echo as having nothing to say", () => {
    writeTodo(richAutoTodo());
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0038 - do-nothing",
      cwd: "/tmp",
      body: ["Working directory: /tmp", "", "Resume with: nothing"].join("\n"),
      timestamp: NOW,
    });
    expect(r.action).toBe("preserved");
  });

  it("still lets a session with real work replace the previous handover", () => {
    writeTodo(richAutoTodo());
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0038 - 2026-08-04 - Did Real Work",
      cwd: "/tmp",
      body: ["Working directory: /tmp", "", "Work completed:", "- shipped the fix"].join("\n"),
      timestamp: NOW,
    });
    expect(r.action).toBe("written");
    expect(readTodo()).toContain("shipped the fix");
  });

  it("still writes when there is no previous block to protect", () => {
    writeTodo("# TODO\n\n- [ ] a real task\n");
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0038 - do-nothing",
      cwd: "/tmp",
      body: NOTHING_TO_SAY,
      timestamp: NOW,
    });
    expect(r.action).toBe("written");
  });
});

/**
 * A superseded handover is moved, not deleted.
 *
 * Reproduced live on 2026-08-04 at 08:36:29Z, in a session that had been open
 * for sixteen minutes: its autosave replaced the previous night's model-authored
 * handover — the one the session had been started to read — with a scrape of its
 * own transcript reading "### What was being asked / - /Name PAI go".
 *
 * Every guard shipped in v0.27.2 stood down correctly. Case 1 needs the same
 * session and this was a different one. Case 1b needs an incoming write with
 * nothing to say and this one had a body. Case 2b needs the existing block to be
 * RECENT and this one was seven hours old. The policy underneath them — an auto
 * write may replace an authored checkpoint from an earlier session — was the
 * thing that had to change, and it rested on an assumption stated in its own
 * comment: that `pai pause` mirrors the body into the session note. This project
 * keeps no session notes at all. The checkpoint was the only copy.
 */
describe("superseded handovers are archived, never destroyed", () => {
  const NOW = "2026-08-04T08:36:29.892Z";
  const HANDOVER = "Everything shipped. v0.27.2 published to npm and pushed.";

  /** Last night's real handover: model-authored, hours old, full of content. */
  function modelTodo(): string {
    return [
      "## Continue",
      "",
      '<!-- pai:checkpoint authored="model" session="0022 - 2026-08-04 - Build Verification" ' +
        'session-id="3de5e8f5-1df3-4945-ba9a-979ac38edd9c" ts="2026-08-04T00:50:54.919Z" -->',
      "",
      "> **Last session:** 0022 - 2026-08-04 - Build Verification",
      "",
      "### Where this stopped",
      "",
      HANDOVER,
      "",
      "<!-- /pai:checkpoint -->",
      "",
      "---",
      "",
      "# TODO",
      "",
      "- [ ] a real task",
      "",
    ].join("\n");
  }

  /** The autosave of a freshly opened session, sixteen minutes in. */
  function autosave(sessionLine = "0023 - 2026-08-04 - New Session") {
    return applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine,
      sessionId: "6ffe89bd-1040-4e9f-b261-7020191e7faf",
      cwd: "/tmp",
      body: ["### What was being asked", "", "- /Name PAI go"].join("\n"),
      timestamp: NOW,
    });
  }

  it("keeps the previous handover's text in the file", () => {
    writeTodo(modelTodo());
    const r = autosave();
    expect(r.action).toBe("written"); // the slot is still taken...
    expect(r.archived).toBe(true);
    expect(readTodo()).toContain(HANDOVER); // ...and the handover survives it
  });

  it("files it under a heading a human will find", () => {
    writeTodo(modelTodo());
    autosave();
    const after = readTodo();
    expect(after).toContain("## Previous handovers");
    expect(after).toContain("0022 - 2026-08-04 - Build Verification");
    // Below the live block, not above it: the current handover is read first.
    expect(after.indexOf("## Continue")).toBeLessThan(after.indexOf("## Previous handovers"));
  });

  it("does not leave a second '## Continue' behind for the next write to find", () => {
    // The archived block carries the heading and the marker that locateContinue
    // scans for. Left intact, the next autosave would treat the archive as the
    // live section — and the one after that would archive the archive.
    writeTodo(modelTodo());
    autosave();
    const after = readTodo();
    expect(after.split("## Continue").length - 1).toBe(1);
    expect(after.split("<!-- pai:checkpoint").length - 1).toBe(1);
  });

  it("survives a run of sessions that each end without pausing", () => {
    // The sequence that actually loses data: nobody pauses, every session
    // autosaves, and each one inherits the slot from the last.
    writeTodo(modelTodo());
    autosave("0023 - first");
    autosave("0024 - second");
    autosave("0025 - third");
    expect(readTodo()).toContain(HANDOVER);
  });

  it("leaves the rest of the document alone", () => {
    writeTodo(modelTodo());
    autosave();
    const after = readTodo();
    expect(after).toContain("# TODO");
    expect(after).toContain("- [ ] a real task");
  });

  it("does not archive a mechanical block, which regenerates anyway", () => {
    // Archiving auto blocks would bury the handovers that matter under a scrape
    // rewritten every few minutes by every open session.
    writeTodo(modelTodo().replace('authored="model"', 'authored="auto"'));
    const r = autosave();
    expect(r.archived).toBeFalsy();
    expect(readTodo()).not.toContain("## Previous handovers");
  });

  it("does not archive the session's own checkpoint", () => {
    // Case 1 already preserves it, so reaching the archive would mean the same
    // handover appearing twice in one file.
    writeTodo(modelTodo());
    const r = applyContinue({
      rootPath: root,
      authored: "auto",
      sessionLine: "0022 - 2026-08-04 - Build Verification",
      sessionId: "3de5e8f5-1df3-4945-ba9a-979ac38edd9c",
      cwd: "/tmp",
      body: "### What was being asked\n\n- something",
      timestamp: NOW,
    });
    expect(r.action).toBe("preserved");
    expect(readTodo()).not.toContain("## Previous handovers");
  });

  it("keeps the archive bounded so TODO.md stays readable", () => {
    let content = modelTodo();
    // Six distinct model handovers, each superseded by an autosave.
    for (let i = 1; i <= 6; i++) {
      writeTodo(content);
      autosave(`00${23 + i} - session ${i}`);
      // Promote the block just written into a model handover from a DIFFERENT
      // session, hours old — which is what the next autosave will find.
      //
      // The id and the stamp both have to move. Leaving the id makes case 1
      // preserve the block; leaving the stamp makes case 2b preserve it, since
      // it was written seconds ago. Either way the loop archives once and then
      // idles, and the first two versions of this test did exactly that:
      // reporting one entry where they meant to build six.
      content = readTodo()
        .replace('authored="auto"', 'authored="model"')
        .replace(/session-id="[^"]*"/, `session-id="0000000${i}-0000-0000-0000-000000000000"`)
        .replace(/ts="[^"]*"/, `ts="2026-08-01T0${i}:00:00.000Z"`)
        .replace("- /Name PAI go", `handover number ${i}`);
    }
    writeTodo(content);
    autosave("0030 - last");
    const after = readTodo();
    expect(after.split("<!-- pai:archived-handover").length - 1).toBe(5);
    // The newest survivors, not the oldest.
    expect(after).toContain("handover number 6");
  });
});

