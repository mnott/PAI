/**
 * The resume probe, and the reason it is allowed to live in exactly one place.
 *
 * `probeResume` was fixed once already — it used to resume the session and send
 * the model a prompt on a 5s budget, so it timed out for large sessions and the
 * caller silently started a fresh one instead. The fix landed here, in
 * lib/launch.ts, and two verbatim copies in commands/main-resolver.ts and
 * commands/session/goto.ts did not get it. `pai <Name>` and `pai resume <name>`
 * both go through those copies, so from the user's side nothing was fixed at
 * all: `pai Paperfull` still reported `spawn error: spawnSync claude ETIMEDOUT`
 * and started over on top of a transcript that was sitting on disk.
 *
 * Hence the last test in this file. The behavioural tests below only protect
 * this copy; the duplicate check is what makes fixing this copy mean something.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { probeResume } from "./launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The whole source tree — the duplicates that were missed lived outside cli/lib. */
const SRC = join(HERE, "..", "..");

/** The project dir a session ran in — the probe's `cwd` argument. */
const CWD = "/Users/someone/dev/A Project";
const ENCODED = CWD.replace(/[^a-zA-Z0-9]/g, "-");

const LIVE = "11111111-1111-4111-8111-111111111111";
const FINISHED = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const STUB = "44444444-4444-4444-8444-444444444444";

/**
 * A transcript with an actual exchange in it. The earlier fixtures here were
 * metadata only, which was accidentally realistic and quietly wrong — they were
 * the very shape `claude --resume` refuses.
 */
const CONVERSATION =
  JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) +
  "\n" +
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" } }) +
  "\n";

/** What 046bb712 actually was: session metadata, no exchange. */
const METADATA_ONLY =
  JSON.stringify({ lastPrompt: "go", customTitle: "PAI", agentName: "claude", mode: "default" }) +
  "\n";

let home: string;

// Per-test, not once: probeResume now REPAIRS the layout it inspects, so a
// shared tree would let one test's restore satisfy the next test's precondition.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-probe-"));
  const dir = join(home, ".claude", "projects", ENCODED);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  // A running session's transcript sits at the top level...
  writeFileSync(join(dir, `${LIVE}.jsonl`), CONVERSATION);
  // ...and the old renaming archivers displaced finished ones into sessions/.
  writeFileSync(join(dir, "sessions", `${FINISHED}.jsonl`), CONVERSATION);
  // A stub that was displaced too. Restoring it changes nothing.
  writeFileSync(join(dir, "sessions", `${STUB}.jsonl`), METADATA_ONLY);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("probeResume answers from the filesystem", () => {
  it("accepts a live session's transcript", () => {
    expect(probeResume(LIVE, CWD, home)).toEqual({ ok: true });
  });

  it("accepts a finished session's transcript under sessions/", () => {
    expect(probeResume(FINISHED, CWD, home)).toEqual({ ok: true });
  });

  /**
   * `claude --resume` reads the top-level path and ONLY that — measured
   * 2026-08-04, a sessions/-only transcript answers "No conversation found".
   * So accepting one is a promise the probe has to keep: it links the file back
   * before saying yes. Without this, the probe's permissive reading is a
   * confident false positive, and launch spawns a resume that cannot work.
   */
  it("puts a sessions/-only transcript back where claude --resume reads it", () => {
    const topLevel = join(home, ".claude", "projects", ENCODED, `${FINISHED}.jsonl`);
    expect(existsSync(topLevel)).toBe(false);

    expect(probeResume(FINISHED, CWD, home)).toEqual({ ok: true });

    expect(existsSync(topLevel)).toBe(true);
    // Linked, not copied — the archive keeps its entry and the disk keeps its bytes.
    const archived = join(home, ".claude", "projects", ENCODED, "sessions", `${FINISHED}.jsonl`);
    expect(statSync(topLevel).ino).toBe(statSync(archived).ino);
  });

  it("leaves a transcript that is already at the top level alone", () => {
    const topLevel = join(home, ".claude", "projects", ENCODED, `${LIVE}.jsonl`);
    const before = statSync(topLevel).ino;
    expect(probeResume(LIVE, CWD, home)).toEqual({ ok: true });
    expect(statSync(topLevel).ino).toBe(before);
  });

  it("rejects a UUID with no transcript, without spawning anything", () => {
    const result = probeResume(ABSENT, CWD, home);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no transcript/i);
  });

  /**
   * Location was only one of the two reasons `claude --resume` refuses. 046bb712
   * was restored to the top level, same inode, and still answered "No
   * conversation found" — 537 bytes of metadata, no exchange. Present is not
   * resumable, and a probe that conflates them hands launch an id that dies.
   */
  it("rejects a restored transcript that holds no conversation", () => {
    const result = probeResume(STUB, CWD, home);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/metadata/i);
  });

  /**
   * The near-miss worth pinning. A bounded head read is the obvious way to
   * write hasConversation, and it is wrong: b3462801 is a real 867 KB session
   * whose LINE 1 is a 762,977-byte hook context attachment, so its first
   * exchange starts past 766 KB. A 256 KB head calls that an empty stub and the
   * probe refuses a session claude --resume would have opened.
   */
  it("finds the conversation behind a huge leading attachment", () => {
    const buried = "55555555-5555-4555-8555-555555555555";
    const dir = join(home, ".claude", "projects", ENCODED);
    writeFileSync(
      join(dir, `${buried}.jsonl`),
      JSON.stringify({ type: "attachment", content: "x".repeat(800_000) }) + "\n" + CONVERSATION
    );
    expect(probeResume(buried, CWD, home)).toEqual({ ok: true });
  });

  it("distinguishes a stub from a missing transcript", () => {
    expect(probeResume(STUB, CWD, home).reason).not.toEqual(
      probeResume(ABSENT, CWD, home).reason
    );
  });

  /**
   * The failure that started all this took 5 seconds to arrive at the wrong
   * answer. Two existsSync calls cannot; if this ever gets slow again, the
   * probe has gone back to spawning something.
   */
  it("costs no measurable time", () => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) probeResume(LIVE, CWD, home);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(500);
  });

  /**
   * An unrecognised project layout is not evidence that the session is gone.
   * Answering "no" here is what made the old code start a fresh session on top
   * of a perfectly good transcript, so the null case must fall through to the
   * spawn rather than short-circuit to a rejection.
   */
  it("does not reject when the project directory is unknown", () => {
    const result = probeResume(LIVE, "/nowhere/at/all", home);
    expect(result.reason).not.toMatch(/no transcript/i);
  });
});

describe("the probe has exactly one implementation", () => {
  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...tsFiles(full));
      else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("is defined in lib/launch.ts and nowhere else", () => {
    const definers = tsFiles(SRC).filter((f) =>
      /\bfunction\s+probeResume\b/.test(readFileSync(f, "utf8"))
    );
    expect(definers.map((f) => f.slice(SRC.length + 1))).toEqual(["cli/lib/launch.ts"]);
  });
});
