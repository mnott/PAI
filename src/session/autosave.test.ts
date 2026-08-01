import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recentPrompts,
  findTranscripts,
  buildAutosaveBody,
} from "./autosave.js";

const SESSION_ID = "6db6ce0a-39ba-4f35-a93b-32dbf379f3a6";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-autosave-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(path: string, entries: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

const lastPrompt = (text: string) => ({
  type: "last-prompt",
  lastPrompt: text,
  sessionId: SESSION_ID,
});

const userMessage = (content: unknown) => ({
  type: "user",
  message: { role: "user", content },
});

// ---------------------------------------------------------------------------

describe("recentPrompts", () => {
  it("reads last-prompt entries in order", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [lastPrompt("first thing"), lastPrompt("second thing")]);

    expect(recentPrompts([p])).toEqual(["first thing", "second thing"]);
  });

  it("spans both halves of a split transcript, oldest first", () => {
    // A session's transcript is archived into sessions/ and continued in a new
    // file under the same UUID. Reading only the newest yields one turn.
    const archived = join(root, "sessions", `${SESSION_ID}.jsonl`);
    const live = join(root, `${SESSION_ID}.jsonl`);
    writeJsonl(archived, [lastPrompt("early turn")]);
    writeJsonl(live, [lastPrompt("late turn")]);

    expect(recentPrompts(findTranscripts(root, SESSION_ID))).toEqual([
      "early turn",
      "late turn",
    ]);
  });

  /**
   * The regression that made the first digest report a six-turn session as one
   * prompt. UserPromptSubmit output is folded into the same user message as the
   * prompt, so rejecting whole messages that begin with a reminder rejected
   * essentially every prompt.
   */
  it("keeps the prompt when a hook reminder shares its message", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [
      userMessage(
        "<system-reminder>\nNEVER do the thing.\n</system-reminder>\nPlease fix the parser."
      ),
    ]);

    expect(recentPrompts([p])).toEqual(["Please fix the parser."]);
  });

  it("strips slash-command markup but keeps the argument", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [
      userMessage(
        "<command-name>/Name</command-name><command-args>PAI</command-args>\nrename it"
      ),
    ]);

    expect(recentPrompts([p])).toEqual(["rename it"]);
  });

  it("ignores tool results and turns that are only machinery", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [
      userMessage([{ type: "tool_result", content: "big blob" }]),
      userMessage("[Request interrupted by user]"),
      userMessage("<system-reminder>only a reminder</system-reminder>"),
      lastPrompt("the real ask"),
    ]);

    expect(recentPrompts([p])).toEqual(["the real ask"]);
  });

  it("prefers last-prompt entries over parsed user messages", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [userMessage("noisy raw text"), lastPrompt("clean prompt")]);

    expect(recentPrompts([p])).toEqual(["clean prompt"]);
  });

  it("drops consecutive duplicates", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [lastPrompt("same"), lastPrompt("same"), lastPrompt("next")]);

    expect(recentPrompts([p])).toEqual(["same", "next"]);
  });

  it("keeps only the most recent N prompts", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, Array.from({ length: 12 }, (_, i) => lastPrompt(`turn ${i}`)));

    const got = recentPrompts([p]);
    expect(got.length).toBeLessThanOrEqual(6);
    expect(got[got.length - 1]).toBe("turn 11");
  });

  it("survives malformed lines and unreadable files", () => {
    const p = join(root, "t.jsonl");
    writeFileSync(p, `not json\n${JSON.stringify(lastPrompt("ok"))}\n`, "utf8");

    expect(recentPrompts([p, join(root, "missing.jsonl")])).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------

describe("findTranscripts", () => {
  it("returns nothing for a directory that does not exist", () => {
    expect(findTranscripts(join(root, "nope"))).toEqual([]);
  });

  it("falls back to the newest file when no session id is given", () => {
    writeJsonl(join(root, "a.jsonl"), [lastPrompt("a")]);
    const found = findTranscripts(root);
    expect(found.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("buildAutosaveBody", () => {
  it("returns empty when there is nothing worth recording", () => {
    expect(buildAutosaveBody({ cwd: root, transcriptPaths: [] })).toBe("");
  });

  /**
   * Guard against overwriting a previous session's handover with noise: a
   * session that has not been asked anything has produced no state, and the
   * dirty tree it inherited is not its doing.
   */
  it("writes nothing before the user has said anything, dirty tree or not", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [userMessage([{ type: "tool_result", content: "blob" }])]);

    // cwd is the PAI repo, which is a git repo with uncommitted changes.
    expect(buildAutosaveBody({ cwd: process.cwd(), transcriptPaths: [p] })).toBe("");
  });

  it("labels itself as automatic so it is never mistaken for authored state", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [lastPrompt("do the thing")]);

    const body = buildAutosaveBody({
      cwd: root,
      transcriptPaths: [p],
      timestamp: "2026-08-01T13:00:00.000Z",
    });

    expect(body).toContain("Automatic checkpoint");
    expect(body).toContain("Written without the model");
    expect(body).toContain("### What was being asked");
    expect(body).toContain("- do the thing");
  });

  it("flattens a multi-line prompt so the list stays a list", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [lastPrompt("line one\nline two")]);

    const body = buildAutosaveBody({ cwd: root, transcriptPaths: [p] });
    expect(body).toContain("- line one line two");
  });
});
