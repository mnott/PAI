import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSupervisionTick, supervisionDirPath, type SupervisorState, type TypeFn } from "./supervision.js";
import type { WorkerStatus } from "./status.js";

const NOW = new Date("2026-10-17T10:00:00");
const LATER = new Date(NOW.getTime() + 90_000);
const SOON = new Date(NOW.getTime() + 30_000);

function worker(state: WorkerStatus["state"], rc: number | null = null): WorkerStatus {
  return {
    id: "w-ptr",
    label: "ptr",
    state,
    rc,
    pid: 1,
    spawnerSession: "sess-1",
    session: { id: "ITERM-UUID" },
    updated: "2026-10-17 10:00:00",
    turns: 1,
  } as unknown as WorkerStatus;
}

describe("undrained alert pointer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ptr-"));
    const base = { isAlive: () => true, push: async () => false };
    await runSupervisionTick(dir, { ...base, now: NOW, statuses: [worker("running")] });
    await runSupervisionTick(dir, { ...base, now: NOW, statuses: [worker("failed", 1)] });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const check = (
    at: Date,
    o: { free?: boolean; sup?: SupervisorState; type?: ReturnType<typeof vi.fn<TypeFn>> } = {}
  ) => {
    const type = o.type ?? vi.fn<TypeFn>(async () => true);
    return runSupervisionTick(dir, {
      now: at,
      isAlive: () => true,
      push: async () => false,
      statuses: [worker("failed", 1)],
      pointer: {
        type,
        inputFree: async () => o.free ?? true,
        supervisorState: () => o.sup ?? "active",
      },
    }).then(() => type);
  };

  it("types the pointer once when undrained past 60 s", async () => {
    const type = await check(LATER);
    expect(type).toHaveBeenCalledTimes(1);
    expect(type.mock.calls[0][0]).toBe("ITERM-UUID");
    expect(String(type.mock.calls[0][1])).toContain("1 worker alert pending");
    await check(new Date(LATER.getTime() + 30_000), { type });
    expect(type).toHaveBeenCalledTimes(1);
  });

  it("types nothing while the alert is under 60 s old", async () => {
    expect(await check(SOON)).not.toHaveBeenCalled();
  });

  it("types nothing once the hook drained the mailbox", async () => {
    writeFileSync(join(supervisionDirPath(dir), "sess-1.cursor"), "1", "utf8");
    expect(await check(LATER)).not.toHaveBeenCalled();
  });

  it("leaves an occupied input line alone and retries next check", async () => {
    const type = await check(LATER, { free: false });
    expect(type).not.toHaveBeenCalled();
    await check(new Date(LATER.getTime() + 30_000), { type });
    expect(type).toHaveBeenCalledTimes(1);
  });

  it("types nothing for paused or finished supervisors", async () => {
    expect(await check(LATER, { sup: "paused" })).not.toHaveBeenCalled();
    expect(await check(LATER, { sup: "finished" })).not.toHaveBeenCalled();
  });
});
