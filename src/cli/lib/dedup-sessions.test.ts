/**
 * Which session a name resolves to.
 *
 * `buildDeduped` decides what `pai <Name>` hands back, so a wrong answer here is
 * not a cosmetic listing bug — it is Matthias typing `pai Paperfull` and getting
 * "No conversation found with session ID" while 867 KB of his work sits on disk
 * one second older than the empty file that beat it.
 *
 * The numbers in these fixtures are measured, not invented: see the table in
 * dedup-sessions.ts. The junk transcripts are 82 KB of hook context in
 * `attachment` lines with no assistant turn anywhere in them.
 */

import { describe, it, expect } from "vitest";
import { buildDeduped } from "./dedup-sessions.js";
import type { ScannedSession } from "./session-scan.js";

/** A finished session as Pass 1b reports it: transcript in sessions/, no top level. */
function disk(over: Partial<ScannedSession> & { uuid: string }): ScannedSession {
  return {
    shortId: over.uuid.slice(0, 8),
    encodedDir: "-Users-i052341-Daten-Cloud-Development-apps-Paperfull",
    decodedPath: "/Users/i052341/Daten/Cloud/Development/apps/Paperfull",
    topLevelPath: "",
    topLevelSystemLines: 0,
    topLevelSize: 0,
    resumable: true,
    sessionStatus: "resumable",
    sessionJsonlPath: `sessions/${over.uuid}.jsonl`,
    userLines: 0,
    lastUserPrompt: "",
    msgCount: 0,
    mtime: 0,
    friendlyName: "Paperfull",
    ...over,
  };
}

// The measured Paperfull collision, to the second.
const REAL = disk({ uuid: "b3462801-2885-4f88-885d-c401629997cf", userLines: 3, msgCount: 32, mtime: Date.parse("2026-08-04T15:41:57Z") });
const JUNK = disk({ uuid: "7fdbb9a8-5095-47fa-b3e7-490c25f3f98e", userLines: 2, msgCount: 25, mtime: Date.parse("2026-08-04T15:41:59Z") });
const JUNK_LATER = disk({ uuid: "a9ecdc1c-428f-4094-b6a2-64b9ce51425c", userLines: 2, msgCount: 25, mtime: Date.parse("2026-08-04T15:49:40Z") });

const winner = (sessions: ScannedSession[]) => {
  const out = buildDeduped([], sessions, undefined, true);
  expect(out).toHaveLength(1); // all three carry the same friendlyName
  return out[0]!.diskSession?.uuid;
};

describe("a failed resume must not outrank the work it failed to open", () => {
  it("keeps the real transcript over an empty one written two seconds later", () => {
    expect(winner([REAL, JUNK])).toBe(REAL.uuid);
  });

  it("does not depend on the order they were scanned in", () => {
    // The incumbent/candidate asymmetry is where a comparator like this breaks:
    // whichever arrives first must not win by arriving first.
    expect(winner([JUNK, REAL])).toBe(REAL.uuid);
  });

  it("still keeps the real transcript when the artefact is eight minutes newer", () => {
    // Ctrl-C, try again, Ctrl-C again. Being repeatedly newer must not add up to
    // being right, or the rule only survives artefacts created within seconds.
    expect(winner([REAL, JUNK, JUNK_LATER])).toBe(REAL.uuid);
    expect(winner([JUNK_LATER, JUNK, REAL])).toBe(REAL.uuid);
  });
});

describe("recency still decides where it is a reasonable guess", () => {
  it("prefers the newer of two transcripts that recorded the same amount", () => {
    const older = disk({ uuid: "11111111-1111-4111-8111-111111111111", userLines: 9, msgCount: 40, mtime: 1000 });
    const newer = disk({ uuid: "22222222-2222-4222-8222-222222222222", userLines: 9, msgCount: 40, mtime: 2000 });
    expect(winner([older, newer])).toBe(newer.uuid);
    expect(winner([newer, older])).toBe(newer.uuid);
  });

  it("breaks a user-line tie on total lines before falling back to recency", () => {
    // Equal user turns, different transcript length: the longer one holds more
    // of the exchange, and it is still the better answer when it is older.
    const fuller = disk({ uuid: "33333333-3333-4333-8333-333333333333", userLines: 4, msgCount: 90, mtime: 1000 });
    const thinner = disk({ uuid: "44444444-4444-4444-8444-444444444444", userLines: 4, msgCount: 25, mtime: 9000 });
    expect(winner([fuller, thinner])).toBe(fuller.uuid);
  });
});

describe("status priority is not overridden by transcript volume", () => {
  it("a resumable session beats a bigger transcript-only one", () => {
    // Volume only ever breaks a tie WITHIN a status. A fat transcript that
    // claude --resume cannot open is still not what the user asked for.
    const fatTranscriptOnly = disk({
      uuid: "55555555-5555-4555-8555-555555555555",
      resumable: false,
      sessionStatus: "transcript-only",
      userLines: 400,
      msgCount: 5000,
      mtime: 9000,
    });
    const thinResumable = disk({ uuid: "66666666-6666-4666-8666-666666666666", userLines: 2, msgCount: 20, mtime: 1000 });
    expect(winner([fatTranscriptOnly, thinResumable])).toBe(thinResumable.uuid);
  });
});
