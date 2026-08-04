import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateTodoContinue } from "./todo.js";
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
    expect(out).not.toContain("Stale checkpoint.");
    expect(out).toContain("Fresh auto state");
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
    // Replaced wholesale — no orphaned tail left behind in the document.
    expect(out).not.toContain("### Watch");
    expect(out).not.toContain("Whisper trim");
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
