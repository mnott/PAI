/**
 * The scan has to see finished sessions.
 *
 * Claude Code writes a running session to <project>/<uuid>.jsonl, and the stop
 * hook MOVES that file to <project>/sessions/<uuid>.jsonl when the session ends.
 * scanSessions walked only the top level, so a session vanished from the catalog
 * the moment it was cleanly stopped — and `pai <name>` resolves names through
 * this catalog. Observed 2026-08-04: `pai Paperfull` reported zero sessions for
 * a project holding three resumable transcripts, and fell through to a free-text
 * search of prompt history.
 *
 * probeResume (lib/launch.ts) has always counted sessions/ as resumable, and
 * `claude --resume` accepts them. The scan was the only disagreeing party.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

// scanSessions resolves ~/.claude/projects at module load, so the stub has to be
// in place before the import below is evaluated.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

const PROJECT = "/Users/someone/dev/Paperfull";
const ENCODED = PROJECT.replace(/[^a-zA-Z0-9]/g, "-");

const RUNNING = "11111111-1111-4111-8111-111111111111";
const FINISHED_NEW = "22222222-2222-4222-8222-222222222222";
const FINISHED_OLD = "33333333-3333-4333-8333-333333333333";

/** Enough of a transcript that parseTopLevel counts it as resumable. */
const SYSTEM_LINE = JSON.stringify({ type: "system", subtype: "init" }) + "\n";
const USER_LINE =
  JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n";

function db() {
  // scanSessions only reads the registry to decorate results; an empty in-memory
  // database exercises the path this test cares about without one.
  return { prepare: () => ({ all: () => [] }) } as never;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-scan-"));
  const dir = join(home, ".claude", "projects", ENCODED);
  mkdirSync(join(dir, "sessions"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

async function scan(filter: "named" | "all" | "resumable") {
  const { scanSessions } = await import("./session-scan.js");
  return scanSessions(db(), { limit: 100, filter }).filter(
    (s) => s.decodedPath.includes("Paperfull") || s.encodedDir === ENCODED
  );
}

function projectDir() {
  return join(home, ".claude", "projects", ENCODED);
}

describe("scanSessions finds sessions the stop hook has moved", () => {
  beforeEach(() => {
    const dir = projectDir();
    writeFileSync(join(dir, `${RUNNING}.jsonl`), SYSTEM_LINE + USER_LINE);
    writeFileSync(join(dir, "sessions", `${FINISHED_NEW}.jsonl`), USER_LINE);
    writeFileSync(join(dir, "sessions", `${FINISHED_OLD}.jsonl`), USER_LINE);
  });

  it("returns the finished sessions as well as the running one", async () => {
    const uuids = (await scan("named")).map((s) => s.uuid).sort();
    expect(uuids).toEqual([RUNNING, FINISHED_NEW, FINISHED_OLD].sort());
  });

  it("calls a moved transcript resumable — that is what claude --resume accepts", async () => {
    const finished = (await scan("named")).find((s) => s.uuid === FINISHED_NEW);
    expect(finished?.resumable).toBe(true);
    expect(finished?.sessionStatus).toBe("resumable");
    expect(finished?.sessionJsonlPath).toBe(
      join(projectDir(), "sessions", `${FINISHED_NEW}.jsonl`)
    );
  });

  /**
   * The name is what `pai <name>` matches on. With no clc entry and no AI title
   * the project directory is the only thing left that a human would recognise,
   * and it is the reason `pai Paperfull` can find Paperfull again.
   */
  it("names them after the project directory", async () => {
    for (const s of await scan("named")) {
      expect(s.friendlyName).toBe("Paperfull");
    }
  });

  it("does not report a session twice when it appears in both places", async () => {
    // A transcript can briefly exist at the top level and under sessions/ at once.
    writeFileSync(join(projectDir(), "sessions", `${RUNNING}.jsonl`), USER_LINE);
    const found = (await scan("all")).filter((s) => s.uuid === RUNNING);
    expect(found).toHaveLength(1);
    // Pass 1 owns it: the top-level file is the live one.
    expect(found[0].topLevelPath).toBe(join(projectDir(), `${RUNNING}.jsonl`));
  });

  it("includes them under the resumable filter too", async () => {
    const uuids = (await scan("resumable")).map((s) => s.uuid);
    expect(uuids).toContain(FINISHED_NEW);
  });
});

describe("a project whose sessions have all ended is still findable", () => {
  it("is not empty just because nothing is running", async () => {
    writeFileSync(
      join(projectDir(), "sessions", `${FINISHED_NEW}.jsonl`),
      USER_LINE
    );
    const found = await scan("named");
    expect(found).toHaveLength(1);
    expect(found[0].friendlyName).toBe("Paperfull");
  });
});
