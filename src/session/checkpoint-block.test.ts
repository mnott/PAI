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
    expect(readTodo()).not.toContain("Whisper trim");
    expect(readTodo()).toContain("0004 - 2026-08-02 - A Later Session");
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
    expect(readTodo()).not.toContain("Whisper trim");
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
