import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveSessionFilesToSessionsDir } from "./paths.js";

/**
 * The archiver is the function that destroyed users' sessions.
 *
 * It used to renameSync transcripts out of the project root into sessions/, and
 * `claude --resume <uuid>` only finds them at the root. Measured 2026-08-04:
 * resuming an 867 KB transcript that lived only in sessions/ answered
 * "No conversation found with session ID". It ran from a UserPromptSubmit hook
 * excluding only the current session, so every prompt anyone typed unresumed
 * every other session in the project — one project measured 1 transcript at the
 * root against 52 underneath.
 *
 * So the assertion that matters in every case below is the same one, and it is
 * about the SOURCE, not the destination: the root file must still be there.
 */

let projectDir: string;
const sessions = () => join(projectDir, "sessions");
const A = "aaaaaaaa-1111-4111-8111-111111111111.jsonl";
const B = "bbbbbbbb-2222-4222-8222-222222222222.jsonl";

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "pai-paths-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("archiving a transcript never removes it from the project root", () => {
  it("leaves the source in place — the whole bug in one assertion", () => {
    writeFileSync(join(projectDir, A), '{"type":"user"}\n');

    expect(archiveSessionFilesToSessionsDir(projectDir, undefined, true)).toBe(1);

    expect(existsSync(join(projectDir, A))).toBe(true); // resume needs THIS one
    expect(existsSync(join(sessions(), A))).toBe(true); // consumers need this one
  });

  it("links rather than copies, so the archive cannot drift or cost space", () => {
    writeFileSync(join(projectDir, A), '{"type":"user"}\n');
    archiveSessionFilesToSessionsDir(projectDir, undefined, true);

    const root = statSync(join(projectDir, A));
    const archived = statSync(join(sessions(), A));
    expect(archived.ino).toBe(root.ino);
    expect(archived.nlink).toBeGreaterThanOrEqual(2);
  });

  it("keeps the archive current as the live transcript grows", () => {
    // One inode means appends are visible through both names. A copy would
    // freeze the archive at archive time, and session-summary-worker reads the
    // archive to write session notes — it would summarise a truncated session.
    writeFileSync(join(projectDir, A), '{"type":"user"}\n');
    archiveSessionFilesToSessionsDir(projectDir, undefined, true);
    writeFileSync(join(projectDir, A), '{"type":"user"}\n{"type":"assistant"}\n');

    expect(readFileSync(join(sessions(), A), "utf8")).toContain("assistant");
  });
});

describe("what it archives", () => {
  it("archives every transcript in the root", () => {
    writeFileSync(join(projectDir, A), "a");
    writeFileSync(join(projectDir, B), "b");

    expect(archiveSessionFilesToSessionsDir(projectDir, undefined, true)).toBe(2);
    expect(existsSync(join(projectDir, A))).toBe(true);
    expect(existsSync(join(projectDir, B))).toBe(true);
  });

  it("skips the excluded live session", () => {
    writeFileSync(join(projectDir, A), "a");
    writeFileSync(join(projectDir, B), "b");

    expect(archiveSessionFilesToSessionsDir(projectDir, B, true)).toBe(1);
    expect(existsSync(join(sessions(), A))).toBe(true);
    expect(existsSync(join(sessions(), B))).toBe(false);
    expect(existsSync(join(projectDir, B))).toBe(true);
  });

  it("ignores files that are not transcripts", () => {
    writeFileSync(join(projectDir, "notes.md"), "x");
    expect(archiveSessionFilesToSessionsDir(projectDir, undefined, true)).toBe(0);
  });

  it("is idempotent, and does not disturb what is already archived", () => {
    // The hooks call this on every prompt and at every session end, so running
    // twice is the normal case, not an edge case.
    writeFileSync(join(projectDir, A), "a");
    expect(archiveSessionFilesToSessionsDir(projectDir, undefined, true)).toBe(1);
    expect(archiveSessionFilesToSessionsDir(projectDir, undefined, true)).toBe(0);
    expect(existsSync(join(projectDir, A))).toBe(true);
  });

  it("leaves an already-archived transcript alone rather than relinking it", () => {
    // A transcript archived by the OLD destructive version: present underneath,
    // absent from the root. Restoring those is a separate repair (launch.ts),
    // and this must not clobber the archived copy while that is pending.
    mkdirSync(sessions(), { recursive: true });
    writeFileSync(join(sessions(), A), "archived-by-the-old-rename");

    expect(archiveSessionFilesToSessionsDir(projectDir, undefined, true)).toBe(0);
    expect(readFileSync(join(sessions(), A), "utf8")).toBe("archived-by-the-old-rename");
  });

  it("returns 0 for a project directory that does not exist", () => {
    expect(
      archiveSessionFilesToSessionsDir(join(projectDir, "nope"), undefined, true)
    ).toBe(0);
  });
});
