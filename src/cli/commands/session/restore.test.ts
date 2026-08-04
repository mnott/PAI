import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findDisplaced, findResumePromises, selectTargets } from "./restore.js";
import type { DisplacedSession } from "./restore.js";

/**
 * The repair for transcripts PAI displaced.
 *
 * A transcript under sessions/ with no twin at the project root cannot be
 * resumed — `claude --resume` reads only the root. Measured 2026-08-04: 867 KB of
 * real work answered "No conversation found with session ID" purely because of
 * where it sat. Meanwhile every checkpoint PAI writes ends with
 * "Resume with: claude --resume <uuid>", so for those sessions the instruction
 * was a lie and nothing said so.
 *
 * The distinction these tests defend is displaced vs merely archived. Archiving
 * is a hardlink now, so the normal state is both names on one inode and nothing
 * to repair. Reporting those as broken would make the command cry wolf over
 * every healthy session in the store.
 */

let projects: string;
const UUID = "b3462801-2885-4f88-885d-c401629997cf";
const OTHER = "046bb712-ab1f-429f-8f73-014f33f58f83";

function project(encoded: string): string {
  const dir = join(projects, encoded);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), "pai-restore-"));
});

afterEach(() => {
  rmSync(projects, { recursive: true, force: true });
});

describe("finding what is actually unresumable", () => {
  it("reports a transcript that exists only under sessions/", () => {
    const dir = project("-Users-x-Paperfull");
    writeFileSync(join(dir, "sessions", `${UUID}.jsonl`), "x".repeat(500));

    const found = findDisplaced(projects);
    expect(found).toHaveLength(1);
    expect(found[0]!.uuid).toBe(UUID);
    expect(found[0]!.bytes).toBe(500);
  });

  it("ignores a transcript that already has its twin at the root", () => {
    // The healthy post-fix state: archiving hardlinks, so both names exist. If
    // this were reported, every session in the store would look broken.
    const dir = project("-Users-x-Healthy");
    writeFileSync(join(dir, `${UUID}.jsonl`), "x");
    writeFileSync(join(dir, "sessions", `${UUID}.jsonl`), "x");

    expect(findDisplaced(projects)).toEqual([]);
  });

  it("ignores files that are not transcripts, and non-uuid names", () => {
    const dir = project("-Users-x-Noise");
    writeFileSync(join(dir, "sessions", "notes.md"), "x");
    writeFileSync(join(dir, "sessions", "not-a-uuid.jsonl"), "x");

    expect(findDisplaced(projects)).toEqual([]);
  });

  it("looks across every project, not just one", () => {
    const a = project("-Users-x-One");
    const b = project("-Users-x-Two");
    writeFileSync(join(a, "sessions", `${UUID}.jsonl`), "x");
    writeFileSync(join(b, "sessions", `${OTHER}.jsonl`), "x");

    expect(findDisplaced(projects).map((d) => d.uuid).sort()).toEqual(
      [OTHER, UUID].sort()
    );
  });

  it("orders by size, so the most lost work reads first", () => {
    const dir = project("-Users-x-Sizes");
    writeFileSync(join(dir, "sessions", `${UUID}.jsonl`), "x".repeat(9000));
    writeFileSync(join(dir, "sessions", `${OTHER}.jsonl`), "x".repeat(10));

    expect(findDisplaced(projects).map((d) => d.uuid)).toEqual([UUID, OTHER]);
  });

  it("returns nothing rather than throwing when there is no projects dir", () => {
    expect(findDisplaced(join(projects, "absent"))).toEqual([]);
  });

  it("skips a project with no sessions/ subdirectory", () => {
    mkdirSync(join(projects, "-Users-x-Bare"), { recursive: true });
    expect(findDisplaced(projects)).toEqual([]);
  });
});

describe("a transcript with no conversation in it", () => {
  /**
   * Measured on 046bb712: 537 bytes of last-prompt / custom-title / agent-name /
   * mode / permission-mode and nothing else. It was restored, correctly
   * hardlinked, and `claude --resume` still answered "No conversation found" —
   * because there was no conversation, wherever the file sat.
   *
   * A checkpoint names that id and tells the user to resume it. The report has to
   * say the promise cannot be kept, rather than counting it as recovered work.
   */
  const STUB =
    '{"type":"last-prompt"}\n{"type":"custom-title"}\n{"type":"agent-name"}\n' +
    '{"type":"mode"}\n{"type":"permission-mode"}\n';

  it("is reported as a stub", () => {
    const dir = project("-Users-x-Stub");
    writeFileSync(join(dir, "sessions", `${OTHER}.jsonl`), STUB);

    const found = findDisplaced(projects);
    expect(found).toHaveLength(1);
    expect(found[0]!.hasConversation).toBe(false);
  });

  it("counts a real exchange as a conversation", () => {
    const dir = project("-Users-x-Real");
    writeFileSync(
      join(dir, "sessions", `${UUID}.jsonl`),
      '{"type":"user"}\n{"type":"assistant"}\n'
    );

    expect(findDisplaced(projects)[0]!.hasConversation).toBe(true);
  });

  it("counts a user-only transcript as a conversation", () => {
    // Refuted by AIBroker with a measurement: b8cd4a5d is 2626 bytes with 3 user
    // lines and no assistant line, and claude --resume FINDS it. Requiring an
    // assistant marker declared resumable sessions empty.
    const dir = project("-Users-x-UserOnly");
    writeFileSync(join(dir, "sessions", `${UUID}.jsonl`), '{"type":"user"}\n');

    expect(findDisplaced(projects)[0]!.hasConversation).toBe(true);
  });

  it("finds a marker that sits past a giant leading attachment", () => {
    // The case that killed the bounded-head version. Measured on b3462801: line 1
    // is a 762,976-byte hook-context attachment and the first "type":"user" is at
    // byte 766,830, so a 256 KB head reported an 867 KB working session — one we
    // had both verified resumable — as an empty stub. 13 of this project's 52
    // transcripts were misjudged this way, every error in the direction of
    // talking the user out of a recovery.
    const dir = project("-Users-x-Attachment");
    const giant = `{"type":"attachment","content":"${"x".repeat(800_000)}"}`;
    writeFileSync(
      join(dir, "sessions", `${UUID}.jsonl`),
      `${giant}\n{"type":"user"}\n`
    );

    expect(findDisplaced(projects)[0]!.hasConversation).toBe(true);
  });

  it("treats an unreadable transcript as real rather than talking the user out of a restore", () => {
    const dir = project("-Users-x-Gone");
    // A directory where a transcript should be: openSync succeeds, readSync fails.
    mkdirSync(join(dir, "sessions", `${UUID}.jsonl`), { recursive: true });

    const found = findDisplaced(projects);
    expect(found).toHaveLength(1);
    expect(found[0]!.hasConversation).toBe(true);
  });
});

describe("naming the promise each restore makes true", () => {
  it("finds the checkpoint that instructs resuming this id", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pai-cwd-"));
    try {
      mkdirSync(join(cwd, "Notes"), { recursive: true });
      writeFileSync(
        join(cwd, "Notes", "TODO.md"),
        `> Resume with: \`claude --resume ${UUID}\`\n`
      );
      writeFileSync(join(cwd, "Notes", "unrelated.md"), "nothing here\n");

      const hits = findResumePromises(UUID, cwd);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain("TODO.md");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("names each note once, not once per path spelling", () => {
    // Caught in review on the real filesystem: the scan tries `Notes` and
    // `notes`, and macOS is case-insensitive, so every promise was reported
    // twice. A report that double-counts the damage is not a report worth
    // trusting to decide a repair.
    const cwd = mkdtempSync(join(tmpdir(), "pai-case-"));
    try {
      mkdirSync(join(cwd, "Notes"), { recursive: true });
      writeFileSync(join(cwd, "Notes", "TODO.md"), `claude --resume ${UUID}\n`);

      expect(findResumePromises(UUID, cwd)).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns nothing when the working directory could not be decoded", () => {
    // Reporting is best-effort: an undecodable project still gets restored, it
    // just cannot name which note promised it.
    expect(findResumePromises(UUID, null)).toEqual([]);
  });
});

describe("what --execute actually touches", () => {
  /**
   * Selection is tested as a pure function on purpose. The first draft of this
   * suite called cmdRestore directly, which defaults to the real
   * ~/.claude/projects — it would have relinked live files on any machine running
   * the tests.
   */
  const session = (over: Partial<DisplacedSession> & { uuid: string }): DisplacedSession => ({
    projectDir: "/p",
    encodedDir: "-p",
    cwd: "/p",
    bytes: 1,
    mtime: 0,
    promisedBy: [],
    hasConversation: true,
    ...over,
  });

  const real = session({ uuid: "real" });
  const stub = session({ uuid: "stub", hasConversation: false });
  const promisedStub = session({ uuid: "promised-stub", hasConversation: false, promisedBy: ["/p/Notes/TODO.md"] });
  const elsewhere = session({ uuid: "elsewhere", cwd: "/other" });

  it("skips stubs by default — guaranteed-null work, and it inflates the damage", () => {
    // Measured 2026-08-04: 2240 of 2869 displaced were stubs, 1493 of them from a
    // single probe tool. Counting those made the loss look 4.5x worse than it is.
    const { inScope, toRestore } = selectTargets([real, stub], {});
    expect(inScope).toHaveLength(2); // still reported
    expect(toRestore.map((d) => d.uuid)).toEqual(["real"]); // not linked
  });

  it("restores stubs when explicitly asked", () => {
    const { toRestore } = selectTargets([real, stub], { includeStubs: true });
    expect(toRestore).toHaveLength(2);
  });

  it("keeps stubs out even when a checkpoint promises them", () => {
    // 046bb712 is exactly this: promised by a checkpoint, and empty. Linking it
    // cannot make the promise true, so --promised must not imply --include-stubs.
    const { inScope, toRestore } = selectTargets([promisedStub], { promised: true });
    expect(inScope).toHaveLength(1);
    expect(toRestore).toHaveLength(0);
  });

  it("honours --cwd", () => {
    const { toRestore } = selectTargets([real, elsewhere], { cwd: "/p" });
    expect(toRestore.map((d) => d.uuid)).toEqual(["real"]);
  });

  it("combines scopes rather than letting the last one win", () => {
    const promisedReal = session({ uuid: "pr", promisedBy: ["/p/Notes/TODO.md"] });
    const { toRestore } = selectTargets([promisedReal, real, elsewhere], {
      promised: true,
      cwd: "/p",
    });
    expect(toRestore.map((d) => d.uuid)).toEqual(["pr"]);
  });
});

describe("restoring", () => {
  it("hardlinks back to the root and leaves the archive in place", async () => {
    const dir = project("-Users-x-Repair");
    const archived = join(dir, "sessions", `${UUID}.jsonl`);
    writeFileSync(archived, "conversation");

    const { restoreTopLevel } = await import("../../lib/launch.js");
    expect(restoreTopLevel(UUID, dir)).toBe(true);

    const top = join(dir, `${UUID}.jsonl`);
    expect(existsSync(top)).toBe(true);
    expect(existsSync(archived)).toBe(true); // never unlink the archive
    expect(statSync(top).ino).toBe(statSync(archived).ino); // linked, not copied

    // And the whole point: it is no longer displaced.
    expect(findDisplaced(projects)).toEqual([]);
  });
});
