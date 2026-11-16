import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escalationReason, escalateOverdue, rerouteWorker, type SpawnSpec } from "./reroute.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reroute-"));
  writeFileSync(join(dir, "spec.txt"), "do the thing", "utf8");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const queued = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id: "w1", pid: 4321, label: "l", cwd: "/", term: "", provider: "fakeA", model: "m", state: "queued", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, promptFile: "/nonexistent-prompt", ...over }) as WorkerStatus;

describe("escalationReason", () => {
  it("an overdue queued job moves; a fresh one and an already rerouted one do not", () => {
    const now = Date.now();
    const held = (sinceMs: number): Partial<WorkerStatus> => ({ capacity: { provider: "fakeA", cap: 1, total: 1, position: 1, elapsedSec: 0, sinceMs } });
    expect(escalationReason(queued(held(now - 16 * 60_000)), now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 })).toBe("queued 16m");
    expect(escalationReason(queued(held(now - 60_000)), now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 })).toBeNull();
    expect(escalationReason(queued({ ...held(now - 16 * 60_000), rerouted: "x" }), now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 })).toBeNull();
  });
});

describe("rerouteWorker", () => {
  it("marks a queued run with the hand-over reason before it is stopped (the caller's follower reads it)", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt") }));
    const seen: Array<string | undefined> = [];
    await rerouteWorker("w1", "cloud", {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
      kill: async (id) => {
        seen.push(loadStatus(dir, id)?.rerouted); // at kill time the marker must already stand
        return [];
      },
      spawn: (_s: SpawnSpec) => undefined,
    });
    expect(seen).toEqual(["fakeB: reroute"]);
    expect(loadStatus(dir, "w1")!.rerouted).toBe("fakeB: reroute");
  });

  it("a restart that cannot start leaves the old run queued and unmarked (no silent drop)", async () => {
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt") }));
    let killed = false;
    await expect(
      rerouteWorker("w1", "cloud", {
        logDir: dir,
        resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
        kill: async () => {
          killed = true;
          return [];
        },
        spawn: () => {
          throw new Error("the restart on fakeB did not start");
        },
      })
    ).rejects.toThrow(/did not start/);
    expect(killed).toBe(false); // the old run was never stopped
    const st = loadStatus(dir, "w1")!;
    expect(st.state).toBe("queued");
    expect(st.rerouted).toBeUndefined(); // a later tick may try again
  });

  it("escalateOverdue hands every overdue queued job over once", async () => {
    const now = Date.now();
    saveStatus(dir, queued({ promptFile: join(dir, "spec.txt"), capacity: { provider: "fakeA", cap: 1, total: 1, position: 1, elapsedSec: 0, sinceMs: now - 16 * 60_000 } }));
    saveStatus(dir, queued({ id: "w2", promptFile: join(dir, "spec.txt"), provider: "fakeB" })); // already on the fallback
    const done = await escalateOverdue([loadStatus(dir, "w1")!, loadStatus(dir, "w2")!], {
      logDir: dir,
      resolve: async () => ({ provider: "fakeB", description: "fake fakeB" }),
      kill: async () => [],
      spawn: () => undefined,
    }, now, { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
    expect(done.map((e) => e.id)).toEqual(["w1"]);
    expect(loadStatus(dir, "w1")!.rerouted).toBe("fakeB: queued 16m"); // the marker names where and why it moved
    expect(loadStatus(dir, "w2")!.rerouted).toBeUndefined();
  });
});
