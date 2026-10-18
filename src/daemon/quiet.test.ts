import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferIfQuiet,
  deferredKinds,
  flushDeferredIfEnded,
  nextOccurrence,
  parseQuiet,
  registerQuietRunner,
  resetQuietForTests,
  setQuietSourceForTests,
} from "./quiet.js";
import { dequeue, enqueue, resetQueueForTests } from "./work-queue.js";
import { upsertProject } from "../cli/impl/registry/utils.js";
import { reportUnregistrable } from "../registry/registrable.js";
import type { RegistryBackend } from "../storage/registry-interface.js";

let quiet: unknown;

beforeEach(() => {
  resetQuietForTests();
  resetQueueForTests();
  quiet = { on: true };
  setQuietSourceForTests(() => quiet);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  setQuietSourceForTests(null);
  vi.restoreAllMocks();
});

describe("quiet mode", () => {
  it("defers every maintenance kind and runs each once when quiet ends", async () => {
    const ran: string[] = [];
    const kinds = ["registry-scan", "index", "embed", "triple-extraction", "maintenance"] as const;
    for (const k of kinds) registerQuietRunner(k, () => void ran.push(k));

    // Repeated triggers while quiet collapse into one deferral per kind.
    for (let i = 0; i < 3; i++) for (const k of kinds) expect(deferIfQuiet(k)).toBe(true);
    expect(await flushDeferredIfEnded()).toEqual([]); // still quiet
    expect(ran).toEqual([]);

    quiet = undefined; // `quiet off`
    expect(await flushDeferredIfEnded()).toHaveLength(5);
    expect([...ran].sort()).toEqual([...kinds].sort());
    expect(await flushDeferredIfEnded()).toEqual([]); // not run twice
    expect(ran).toHaveLength(5);
    expect(deferIfQuiet("index")).toBe(false);
  });

  it("ends by itself at --until", async () => {
    const ran: string[] = [];
    registerQuietRunner("index", () => void ran.push("index"));
    const t0 = Date.now();
    quiet = { on: true, until: new Date(t0 + 60_000).toISOString() };
    expect(deferIfQuiet("index", t0)).toBe(true);
    expect(await flushDeferredIfEnded(t0 + 30_000)).toEqual([]);
    expect(await flushDeferredIfEnded(t0 + 61_000)).toEqual(["index"]);
    expect(ran).toEqual(["index"]);
    expect(deferIfQuiet("index", t0 + 61_000)).toBe(false);
    expect(deferredKinds()).toEqual([]);
  });

  it("parses state and HH:MM", () => {
    expect(parseQuiet(undefined)).toEqual({ on: false });
    expect(parseQuiet({ on: true })).toEqual({ on: true });
    expect(parseQuiet({ on: true, until: "2000-01-01T00:00:00Z" })).toEqual({ on: false });
    const now = new Date(2026, 0, 1, 10, 0).getTime();
    expect(new Date(nextOccurrence("07:00", now)).getDate()).toBe(2);
    expect(new Date(nextOccurrence("23:30", now)).getDate()).toBe(1);
    expect(() => nextOccurrence("25:00", now)).toThrow();
  });

  it("keeps queued session-summary dispatching while registry-scan stays pending", () => {
    enqueue({ type: "registry-scan", priority: 1, payload: {} });
    enqueue({ type: "session-summary", priority: 3, payload: {} });
    const skip = new Set(["registry-scan"] as const);
    expect(dequeue(skip)?.type).toBe("session-summary");
    expect(dequeue(skip)).toBeNull();
    expect(dequeue()?.type).toBe("registry-scan"); // not dropped
  });
});

describe("registration path filter", () => {
  const rows = [
    { id: 1, slug: "a", root_path: "/Users/x/.claude/pai/logs/workers/worktrees/w1" },
    { id: 2, slug: "b", root_path: "/private/tmp/ops" },
    { id: 3, slug: "c", root_path: "/Users/x/dev/real" },
  ];
  const backend = {
    listProjects: async () => rows,
    getProjectByRootPath: vi.fn(),
    deleteProjectCascade: vi.fn(),
  } as unknown as RegistryBackend;

  it("upsertProject refuses worker, worktree and temp paths", async () => {
    expect(await upsertProject(backend, "w1", rows[0].root_path, "enc")).toBeNull();
    expect(await upsertProject(backend, "ops", rows[1].root_path, "enc")).toBeNull();
    expect(backend.getProjectByRootPath).not.toHaveBeenCalled();
  });

  it("dry-run report counts matches and deletes nothing", async () => {
    const r = await reportUnregistrable(backend, undefined);
    expect(r).toMatchObject({ total: 3, matching: 2, matchingMissing: 2 });
    expect(backend.deleteProjectCascade).not.toHaveBeenCalled();
  });
});
