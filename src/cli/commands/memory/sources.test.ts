import { describe, it, expect, vi, afterEach } from "vitest";
import type { StorageBackend } from "../../../storage/interface.js";
import { cmdMemorySources, rootOf } from "./sources.js";

/**
 * This command exists because the index grew past 1.5M chunks against a vault of
 * ~2,700 notes and nothing could show why. `memory status` reports nothing at all
 * when the backend is not SQLite, and `daemon status` gives totals without
 * composition — so the answer needed hand-written SQL against the container.
 *
 * The two things it must get right are therefore: read whichever backend is
 * configured, and separate "large" from "being rewritten", because only the
 * second means the embedder can never finish.
 */

afterEach(() => vi.restoreAllMocks());

const capture = () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  return () => lines.join("\n");
};

/** A Postgres-shaped backend whose queries answer from canned rows in order. */
const pgBackend = (batches: Record<string, unknown>[][]): StorageBackend => {
  let i = 0;
  return {
    backendType: "postgres",
    getPool: () => ({
      query: () => Promise.resolve({ rows: batches[i++] ?? [] }),
    }),
  } as unknown as StorageBackend;
};

const sqliteBackend = (batches: Record<string, unknown>[][]): StorageBackend => {
  let i = 0;
  return {
    backendType: "sqlite",
    getSqliteDb: () => ({ prepare: () => ({ all: () => batches[i++] ?? [] }) }),
  } as unknown as StorageBackend;
};

const COMP = [
  { source: "vault", tier: "topic", chunks: 900, embedded: 90 },
  { source: "notes", tier: "session", chunks: 100, embedded: 100 },
];
const PATHS = [
  { path: "Linked Tree/Notes/a.md", chunks: 800 },
  { path: "Own/Notes/b.md", chunks: 200 },
];
const CHURN = [{ day: "2026-08-07", chunks: 900, embedded: 20 }];

describe("reading whichever backend is configured", () => {
  it("reports from a Postgres backend", async () => {
    const out = capture();
    await cmdMemorySources(pgBackend([COMP, PATHS, CHURN]));
    expect(out()).toMatch(/backend: postgres/);
    expect(out()).toMatch(/vault \/ topic/);
  });

  it("reports from a SQLite backend too", async () => {
    const out = capture();
    await cmdMemorySources(sqliteBackend([COMP, PATHS, CHURN]));
    expect(out()).toMatch(/backend: sqlite/);
  });

  it("says so plainly when there is nothing indexed", async () => {
    // An empty index and an unreachable backend look the same from here, so the
    // message must not claim the index is empty.
    const out = capture();
    await cmdMemorySources(pgBackend([[], [], []]));
    expect(out()).toMatch(/Nothing indexed yet, or the backend is unreachable/);
  });
});

describe("surfacing the things that were invisible", () => {
  it("totals chunks and embedded, with the embedded share", async () => {
    const out = capture();
    await cmdMemorySources(pgBackend([COMP, PATHS, CHURN]));
    expect(out()).toMatch(/1[’',]000 chunks/);
    expect(out()).toMatch(/190 embedded \(19%\)/);
  });

  it("groups by entry root, so one leaked tree is visible as a share", async () => {
    const out = capture();
    await cmdMemorySources(pgBackend([COMP, PATHS, CHURN]));
    expect(out()).toMatch(/Linked Tree\/Notes\/…/);
    expect(out()).toMatch(/80%/); // 800 of 1000
  });

  it("reports how many chunks still need embedding", async () => {
    const out = capture();
    await cmdMemorySources(pgBackend([COMP, PATHS, CHURN]));
    expect(out()).toMatch(/810 chunks still need embedding/);
  });

  it("shows a rewrite day as high volume with a low embedded share", async () => {
    // This is the distinction the whole command is for: a finite backlog embeds
    // what it writes, a treadmill does not.
    const out = capture();
    await cmdMemorySources(pgBackend([COMP, PATHS, CHURN]));
    expect(out()).toMatch(/2026-08-07/);
    expect(out()).toMatch(/20 \(2%\)/);
  });
});

describe("rootOf", () => {
  it("keeps the first two segments and marks the rest", () => {
    expect(rootOf("a/b/c/d.md")).toBe("a/b/…");
  });

  it("returns short paths unchanged", () => {
    expect(rootOf("a/b")).toBe("a/b");
    expect(rootOf("only.md")).toBe("only.md");
  });

  it("tolerates leading slashes and empty segments", () => {
    expect(rootOf("/x/y/z.md")).toBe("x/y/…");
  });
});
