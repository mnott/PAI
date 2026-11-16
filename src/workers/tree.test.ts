import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchParent } from "./tree.js";

function logDirWith(id: string, parent?: string): string {
  const dir = join(tmpdir(), `tree-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.status`), JSON.stringify({ id, label: id, state: "running", pid: 1, started: "2026-11-16 10:00:00", updated: "2026-11-16 10:00:00", ...(parent ? { parent } : {}) }));
  return dir;
}

describe("launchParent", () => {
  it("a run started inside a worker records that worker from the first status", () => {
    expect(launchParent(undefined, { PAI_WORKER_ID: "L1-id" })).toBe("L1-id");
  });
  it("an explicit parent wins over the env", () => {
    expect(launchParent("chain-id", { PAI_WORKER_ID: "L1-id" })).toBe("chain-id");
  });
  it("a top-level run has no parent", () => {
    expect(launchParent(undefined, {})).toBeNull();
  });
  it("a detached reroute restart (no PAI_WORKER_ID) inherits the parent of the run it continues", () => {
    const dir = logDirWith("old-run", "L1-id");
    expect(launchParent(undefined, { PAI_RERUN_OF: "old-run" }, dir)).toBe("L1-id");
  });
  it("a restart of a top-level run stays parentless", () => {
    const dir = logDirWith("old-run");
    expect(launchParent(undefined, { PAI_RERUN_OF: "old-run" }, dir)).toBeNull();
  });
});
