/**
 * The scan has to see finished sessions.
 *
 * Claude Code writes a running session to <project>/<uuid>.jsonl, and the stop
 * hook MOVES that file to <project>/sessions/<uuid>.jsonl when the session ends.
 * scanSessions walked only the top level, so a session vanished from the catalog
 * the moment it was cleanly stopped — and `pai <name>` resolves names through
 * this catalog. Observed 2026-08-04: `pai Northwind` reported zero sessions for
 * a project holding three resumable transcripts, and fell through to a free-text
 * search of prompt history.
 *
 * probeResume (lib/launch.ts) has always counted sessions/ as resumable, and
 * `claude --resume` accepts them. The scan was the only disagreeing party.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

// scanSessions resolves ~/.claude/projects at module load, so the stub has to be
// in place before the import below is evaluated.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

// scanSessions reads the registry (via getRegistryBackend()) only to decorate
// results with root paths — stub it so the test never opens the real registry.db.
vi.mock("../../storage/factory.js", () => ({
  getRegistryBackend: async () => ({ listProjects: async () => [] }),
}));

const PROJECT = "/Users/someone/dev/Northwind";
const ENCODED = PROJECT.replace(/[^a-zA-Z0-9]/g, "-");

const RUNNING = "11111111-1111-4111-8111-111111111111";
const FINISHED_NEW = "22222222-2222-4222-8222-222222222222";
const FINISHED_OLD = "33333333-3333-4333-8333-333333333333";

/** Enough of a transcript that parseTopLevel counts it as resumable. */
const SYSTEM_LINE = JSON.stringify({ type: "system", subtype: "init" }) + "\n";
const USER_LINE =
  JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n";

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
  return (await scanSessions({ limit: 100, filter })).filter(
    (s) => s.decodedPath.includes("Northwind") || s.encodedDir === ENCODED
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
   * and it is the reason `pai Northwind` can find Northwind again.
   */
  it("names them after the project directory", async () => {
    for (const s of await scan("named")) {
      expect(s.friendlyName).toBe("Northwind");
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
    expect(found[0].friendlyName).toBe("Northwind");
  });
});

describe("the parse cache", () => {
  // The cache trades "always re-read every file" for "(path, mtime, size)
  // freshness". These tests pin the two properties that make that safe:
  // an unchanged file yields the identical result from cache, and a changed
  // file is re-parsed rather than answered from the stale entry.
  beforeEach(() => {
    const dir = projectDir();
    writeFileSync(join(dir, `${RUNNING}.jsonl`), SYSTEM_LINE + USER_LINE);
    writeFileSync(join(dir, "sessions", `${FINISHED_NEW}.jsonl`), USER_LINE);
  });

  it("answers a second scan from cache with identical results", async () => {
    const first = await scan("named");
    const second = await scan("named");
    expect(second).toEqual(first);
  });

  it("persists the cache under the (sandboxed) PAI_HOME dir", async () => {
    await scan("named");
    expect(existsSync(join(home, ".pai", "session-scan-cache.json"))).toBe(true);
  });

  it("re-parses a file whose content changed", async () => {
    const before = await scan("named");
    // Same uuid, different content AND size — a rewrite the cache key must see.
    writeFileSync(
      join(projectDir(), `${RUNNING}.jsonl`),
      SYSTEM_LINE + SYSTEM_LINE + USER_LINE
    );
    const after = await scan("named");
    const running = (rows: typeof before) => rows.find((s) => s.uuid === RUNNING);
    expect(running(after)?.topLevelSystemLines).toBe(
      (running(before)?.topLevelSystemLines ?? 0) + 1
    );
  });
});

describe("the parse cache follows appended lines", () => {
  const ID = "77777777-7777-4777-8777-777777777777";
  it("counts lines appended after the cached parse without re-reading the old ones", async () => {
    const file = join(projectDir(), `${ID}.jsonl`);
    writeFileSync(file, SYSTEM_LINE + USER_LINE);
    const before = (await scan("named")).find((s) => s.uuid === ID);
    appendFileSync(file, SYSTEM_LINE);
    const after = (await scan("named")).find((s) => s.uuid === ID);
    expect(after?.topLevelSystemLines).toBe((before?.topLevelSystemLines ?? 0) + 1);
  });
  it("a named session in a nested sessions/ dir with an old mtime is still scanned", async () => {
    const file = join(projectDir(), "sessions", `${ID}.jsonl`);
    writeFileSync(file, '{"type":"custom-title","customTitle":"Jobs Example"}\n' + USER_LINE);
    const old = new Date(Date.now() - 400 * 86_400_000);
    utimesSync(file, old, old);
    const found = (await scan("named")).find((s) => s.uuid === ID);
    expect(found?.persistentName).toBe("Jobs Example");
  });
});

describe("scanSessions leaves worker sessions out", () => {
  const WORKER_SESSION = "44444444-4444-4444-8444-444444444444";
  const NO_WORKTREE_SESSION = "55555555-5555-4555-8555-555555555555";
  const NUMERIC_SESSION = "66666666-6666-4666-8666-666666666666";

  async function seed() {
    const { readWorkersSection } = await import("../../workers/config.js");
    const { workersLogDir } = await import("../../workers/paths.js");
    const logDir = workersLogDir(readWorkersSection().workers);
    const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
    const workerDir = join(home, ".claude", "projects", enc(join(logDir, "worktrees", "17866")));
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, `${WORKER_SESSION}.jsonl`), SYSTEM_LINE + USER_LINE);
    // --no-worktree worker: ordinary cwd, known only through its status file
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "w-1.status"), JSON.stringify({ id: "w-1", claudeSession: NO_WORKTREE_SESSION }));
    writeFileSync(join(projectDir(), `${NO_WORKTREE_SESSION}.jsonl`), SYSTEM_LINE + USER_LINE);
    // a real project whose directory is called "17866"
    const real = join(home, ".claude", "projects", enc("/Users/someone/dev/17866"));
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, `${NUMERIC_SESSION}.jsonl`), SYSTEM_LINE + USER_LINE);
  }

  async function uuids(opts: { filter: "named" | "all"; workers?: boolean }) {
    const { scanSessions } = await import("./session-scan.js");
    return (await scanSessions({ limit: 100, ...opts })).map((s) => s.uuid);
  }

  it("excludes worker sessions by default and with --all", async () => {
    await seed();
    for (const filter of ["named", "all"] as const) {
      const got = await uuids({ filter });
      expect(got).not.toContain(WORKER_SESSION);
      expect(got).not.toContain(NO_WORKTREE_SESSION);
    }
  });

  it("includes them with workers: true", async () => {
    await seed();
    const got = await uuids({ filter: "all", workers: true });
    expect(got).toContain(WORKER_SESSION);
    expect(got).toContain(NO_WORKTREE_SESSION);
  });

  it("keeps a normal project with a numeric-looking name", async () => {
    await seed();
    expect(await uuids({ filter: "named" })).toContain(NUMERIC_SESSION);
  });

  it("lets real projects fill the cut", async () => {
    await seed();
    const { scanSessions } = await import("./session-scan.js");
    const got = (await scanSessions({ limit: 1, filter: "named" })).map((s) => s.uuid);
    expect(got).toEqual([NUMERIC_SESSION]);
  });
});
