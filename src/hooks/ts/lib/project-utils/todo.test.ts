import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateTodoContinue, sessionIdFromTranscript } from "./todo.js";
import { applyContinue } from "../../../../session/checkpoint-block.js";

/**
 * updateTodoContinue is the unattended writer — the pre-compact hook and the
 * daemon work-queue worker both come through it. It is the function that
 * actually destroyed model-authored checkpoints: `pai pause` wrote one, this
 * ran on session end, and the checkpoint became
 * "Working directory: … Check the latest session note for details."
 */

const NOTE = "0002 - 2026-08-01 - Token Burn Diagnosis";
const RICH_BODY = [
  "### Open decisions",
  "",
  "- Whether the daily check needs an owner",
  "",
  "---",
  "",
  "### Watch",
  "",
  "- Whisper trim: two rules changed at once.",
].join("\n");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-todo-test-"));
  mkdirSync(join(root, "Notes"), { recursive: true });
  writeFileSync(
    join(root, "Notes", "TODO.md"),
    "## Infrastructure\n\nDo not lose me.\n",
    "utf8"
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readTodo(): string {
  return readFileSync(join(root, "Notes", "TODO.md"), "utf8");
}

describe("updateTodoContinue", () => {
  it("does not destroy an authored checkpoint for the same session", () => {
    // What `pai pause --body-file` does.
    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: NOTE,
      sessionId: "d840b282-7fc1-4cf6-b51e-8a951f6d88e6",
      cwd: root,
      body: RICH_BODY,
    });

    // What the daemon does seconds later on session end. This is the exact
    // call that used to wipe it.
    updateTodoContinue(
      root,
      `${NOTE}.md`,
      `Working directory: ${root}`,
      "session-end"
    );

    const out = readTodo();
    expect(out).toContain("Whisper trim: two rules changed at once.");
    expect(out).toContain("### Open decisions");
    expect(out).toContain("claude --resume d840b282-7fc1-4cf6-b51e-8a951f6d88e6");
    expect(out).toContain("Do not lose me.");
  });

  it("still writes when there is no authored checkpoint to protect", () => {
    updateTodoContinue(root, `${NOTE}.md`, "Some auto state", "session-end");

    const out = readTodo();
    expect(out).toContain("## Continue");
    expect(out).toContain(NOTE);
    expect(out).toContain("Some auto state");
    expect(out).toContain("Do not lose me.");
  });

  it("replaces an authored checkpoint belonging to an earlier session", () => {
    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: "0001 - 2026-07-31 - Earlier",
      cwd: root,
      body: "Stale checkpoint.",
      // Dated, deliberately. Without a stamp this block is written NOW, so the
      // scenario becomes "an earlier session whose checkpoint is a millisecond
      // old" — which cannot happen, and which a model checkpoint is now
      // protected from being overwritten in. A real predecessor is hours old.
      timestamp: "2026-07-31T09:00:00.000Z",
    });

    updateTodoContinue(root, `${NOTE}.md`, "Fresh auto state", "session-end");

    const out = readTodo();
    expect(out).toContain("Fresh auto state");
    // Replaced in the slot, kept in the file. `not.toContain` here was the
    // assertion that made destroying a predecessor's handover look correct;
    // on 2026-08-04 a live session lost one to exactly this path.
    expect(out).toContain("Stale checkpoint.");
    expect(out).toContain("## Previous handovers");
  });

  it("does not shred a rich body at the first --- inside it", () => {
    // The old strip regex was /## Continue\n[\s\S]*?\n---\n+/ — non-greedy to
    // the first horizontal rule, which for this body is in the middle.
    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine: "0001 - 2026-07-31 - Earlier",
      cwd: root,
      body: RICH_BODY,
      timestamp: "2026-07-31T09:00:00.000Z", // see above — a real predecessor is old
    });

    updateTodoContinue(root, `${NOTE}.md`, "Fresh auto state", "session-end");

    const out = readTodo();
    // Moved wholesale — no orphaned tail left behind, and no second copy.
    //
    // The regression this pins is the strip, not the policy: the old regex ran
    // to the FIRST `---`, which for this body is in the middle, so half the
    // block stayed in the document while the other half was rewritten. One
    // occurrence of each marker is what "the whole block moved" looks like now
    // that the block is archived rather than deleted.
    expect(out.split("### Watch").length - 1).toBe(1);
    expect(out.split("Whisper trim").length - 1).toBe(1);
    expect(out.indexOf("### Watch")).toBeGreaterThan(out.indexOf("## Previous handovers"));
    expect(out).toContain("Do not lose me.");
    expect(out.split("## Continue").length - 1).toBe(1);
  });

  it("refreshes the Last updated stamp without duplicating it", () => {
    updateTodoContinue(root, `${NOTE}.md`, "First", "session-end");
    updateTodoContinue(root, `${NOTE}.md`, "Second", "session-end");

    const out = readTodo();
    expect(out.split("*Last updated:").length - 1).toBe(1);
    expect(out).toContain("Second");
  });
});

/**
 * Identity survives the note being renamed.
 *
 * `isSameSession` prefers the UUID and falls back to the note filename. The
 * fallback is not a detail: `pai pause` RENAMES the note as it writes, so a
 * session that identifies itself by title stops recognising its own checkpoint
 * seconds after writing it — and an automated write is then free to replace it
 * as a predecessor's. Three sessions hit this on 2026-08-03 from one
 * `pai pause all`; PAI's own checkpoint was lost to it on 2026-08-04.
 *
 * Both session-end writers hold the transcript path, whose basename IS the
 * session UUID, and neither used it until now.
 */
describe("session identity survives a renamed note", () => {
  const UUID = "6ffe89bd-1040-4e9f-b261-7020191e7faf";

  function seedModelCheckpoint(sessionLine: string): void {
    applyContinue({
      rootPath: root,
      authored: "model",
      sessionLine,
      sessionId: UUID,
      cwd: root,
      body: "Irreplaceable reasoning nobody wants flattened to a template.",
      // Hours old, so the recency grace cannot be what saves it — the UUID must be.
      timestamp: "2026-08-04T00:00:00.000Z",
    });
  }

  it("preserves a model checkpoint when only the note TITLE changed", () => {
    seedModelCheckpoint("0022 - 2026-08-04 - Old Title");

    // Same session, renamed note. Without the id threaded through, the title
    // comparison fails, this reads as a predecessor, and the handover is gone.
    updateTodoContinue(root, "0022 - 2026-08-04 - Renamed By The Pause.md", "auto state", "session-end", UUID);

    const out = readTodo();
    expect(out).toContain("Irreplaceable reasoning");
    expect(out).not.toContain("auto state");
  });

  it("still replaces a genuinely different session carrying a different id", () => {
    seedModelCheckpoint("0022 - 2026-08-04 - Earlier");

    updateTodoContinue(root, "0023 - 2026-08-04 - A Later Session.md", "auto state", "session-end",
      "11111111-2222-3333-4444-555555555555");

    expect(readTodo()).toContain("auto state");
  });

  it("sessionIdFromTranscript reads the uuid, and refuses anything else", () => {
    expect(sessionIdFromTranscript(`/x/y/${UUID}.jsonl`)).toBe(UUID);
    expect(sessionIdFromTranscript(`/x/y/sessions/${UUID}.jsonl`)).toBe(UUID);
    // A wrong id is worse than none: it makes two different sessions compare equal.
    expect(sessionIdFromTranscript("/x/y/not-a-uuid.jsonl")).toBeUndefined();
    expect(sessionIdFromTranscript(undefined)).toBeUndefined();
  });
});
