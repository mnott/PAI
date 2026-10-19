import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSlotCurrent, currentWorkerId, setSlotCurrent } from "./worker-id.js";
import { slotCurrentPath } from "./paths.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dirs: string[] = [];
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pai-worker-id-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const status = (id: string, state: WorkerStatus["state"]): WorkerStatus =>
  ({ id, pid: 1, label: "l", cwd: "/", term: "", provider: "p", model: "m", state, started: "2026-01-01 00:00:00", updated: "2026-01-01 00:00:00", turns: 0, tools: 0, last: "", rc: null, secs: null }) as WorkerStatus;

describe("currentWorkerId", () => {
  it("PAI_WORKER_ID wins over a slot file", () => {
    const d = mk();
    saveStatus(d, status("slotjob", "running"));
    setSlotCurrent(d, "s-1", "slotjob");
    expect(currentWorkerId({ PAI_WORKER_ID: "own", PAI_POOL_SLOT: "s-1" }, d)).toBe("own");
  });

  it("uses the slot's current job when the env id is missing", () => {
    const d = mk();
    saveStatus(d, status("slotjob", "running"));
    setSlotCurrent(d, "s-1", "slotjob");
    expect(currentWorkerId({ PAI_POOL_SLOT: "s-1" }, d)).toBe("slotjob");
  });

  it("is undefined without a slot, without a file, after clear, or for a finished job", () => {
    const d = mk();
    expect(currentWorkerId({}, d)).toBeUndefined();
    expect(currentWorkerId({ PAI_POOL_SLOT: "s-1" }, d)).toBeUndefined();
    saveStatus(d, status("old", "done"));
    setSlotCurrent(d, "s-1", "old");
    expect(currentWorkerId({ PAI_POOL_SLOT: "s-1" }, d)).toBeUndefined();
    setSlotCurrent(d, "s-1", "never-existed");
    expect(currentWorkerId({ PAI_POOL_SLOT: "s-1" }, d)).toBeUndefined();
    saveStatus(d, status("live", "running"));
    setSlotCurrent(d, "s-1", "live");
    clearSlotCurrent(d, "s-1");
    expect(currentWorkerId({ PAI_POOL_SLOT: "s-1" }, d)).toBeUndefined();
    mkdirSync(join(d, "slots"), { recursive: true });
    writeFileSync(slotCurrentPath(d, "s-2"), "\n");
    expect(currentWorkerId({ PAI_POOL_SLOT: "s-2" }, d)).toBeUndefined();
  });
});
