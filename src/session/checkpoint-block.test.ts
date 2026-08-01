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
    });

    expect(result.action).toBe("written");
    expect(readTodo()).not.toContain("Whisper trim");
    expect(readTodo()).toContain("0004 - 2026-08-02 - A Later Session");
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
