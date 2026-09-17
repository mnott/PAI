/**
 * Tests for the worker tree: parent detection from the environment, depth
 * computation, the running-children count and both tree caps. Pure status
 * files in a tmp dir — nothing spawns a worker.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertChildAllowed,
  isWorkerId,
  launchParent,
  parentFromEnv,
  runningChildren,
  workerDepth,
  WORKER_ID_ENV,
} from "./tree.js";
import { DEFAULT_TREE } from "./config.js";
import { loadStatuses, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-tree-test-"));

function status(id: string, over: Partial<WorkerStatus> = {}): WorkerStatus {
  const s: WorkerStatus = {
    id,
    pid: process.pid,
    label: id,
    cwd: dir,
    term: "",
    provider: "testprov",
    model: "test-1",
    state: "running",
    started: "2026-09-17 10:00:00",
    updated: "2026-09-17 10:00:00",
    turns: 0,
    tools: 0,
    last: "",
    rc: null,
    secs: null,
    ...over,
  };
  saveStatus(dir, s);
  return s;
}

describe("parentFromEnv", () => {
  it("reads the worker id the runner exports", () => {
    expect(parentFromEnv({ [WORKER_ID_ENV]: "w-parent" })).toBe("w-parent");
    expect(parentFromEnv({ [WORKER_ID_ENV]: "  padded  " })).toBe("padded");
  });
  it("returns null outside a worker", () => {
    expect(parentFromEnv({})).toBeNull();
    expect(parentFromEnv({ [WORKER_ID_ENV]: "" })).toBeNull();
    expect(parentFromEnv({ [WORKER_ID_ENV]: "   " })).toBeNull();
  });
});

describe("launchParent", () => {
  it("lets an explicit parent (chain stage, planner child) win over the env", () => {
    expect(launchParent("chain-1", { [WORKER_ID_ENV]: "w-parent" })).toBe("chain-1");
  });
  it("falls back to the worker this process runs inside", () => {
    expect(launchParent(undefined, { [WORKER_ID_ENV]: "w-parent" })).toBe("w-parent");
    expect(launchParent(undefined, {})).toBeNull();
  });
});

describe("workerDepth", () => {
  it("counts levels of worker parents", () => {
    status("top");
    status("mid", { parent: "top" });
    status("leaf", { parent: "mid" });
    const all = loadStatuses(dir).filter((s) => ["top", "mid", "leaf"].includes(s.id));
    expect(workerDepth(all, "top")).toBe(0);
    expect(workerDepth(all, "mid")).toBe(1);
    expect(workerDepth(all, "leaf")).toBe(2);
  });
  it("treats a parent without a status (chain id, stale) as a root", () => {
    const s = status("stage", { parent: "chain-9" });
    expect(workerDepth([s], "stage")).toBe(0);
  });
  it("survives a parent cycle", () => {
    const a = status("a", { parent: "b" });
    const b = status("b", { parent: "a" });
    expect(workerDepth([a, b], "a")).toBeGreaterThanOrEqual(0);
  });
});

describe("runningChildren", () => {
  it("counts only children that are running and alive", () => {
    status("p");
    status("c1", { parent: "p" });
    status("c2", { parent: "p" });
    status("c3", { parent: "p", state: "done" });
    status("c4", { parent: "p", pid: -1 }); // dead pid
    status("c5", { parent: "other" });
    const all = loadStatuses(dir).filter((s) => ["p", "c1", "c2", "c3", "c4", "c5"].includes(s.id));
    expect(runningChildren(all, "p").map((s) => s.id)).toEqual(["c1", "c2"]);
  });
});

describe("assertChildAllowed", () => {
  it("allows a child of a top-level worker (depth 1 ≤ maxDepth)", () => {
    status("p");
    assertChildAllowed(dir, "p", DEFAULT_TREE);
  });

  it("allows a parent without a status file (chain id) uncapped", () => {
    assertChildAllowed(dir, "chain-9", { maxDepth: 0, maxChildren: 1 });
  });

  it("refuses one level past maxDepth, suggesting the handoff", () => {
    status("top");
    status("mid", { parent: "top" }); // depth 1
    expect(() =>
      assertChildAllowed(dir, "mid", { maxDepth: 1, maxChildren: 4 })
    ).toThrow(/maxDepth.*pai worker handoff/);
  });

  it("refuses a child beyond maxChildren running at once, naming them", () => {
    status("p");
    status("c1", { parent: "p" });
    status("c2", { parent: "p" });
    expect(() => assertChildAllowed(dir, "p", { maxDepth: 2, maxChildren: 2 })).toThrow(
      /2 running sub-workers.*c1, c2.*maxChildren/
    );
  });

  it("finished children do not count against maxChildren", () => {
    status("p2");
    status("d1", { parent: "p2", state: "done" });
    assertChildAllowed(dir, "p2", { maxDepth: 2, maxChildren: 1 });
  });
});

describe("isWorkerId", () => {
  it("is true exactly for ids with a status file", () => {
    status("known");
    expect(isWorkerId(dir, "known")).toBe(true);
    expect(isWorkerId(dir, "chain-9")).toBe(false);
  });
});
