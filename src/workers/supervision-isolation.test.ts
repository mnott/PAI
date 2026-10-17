import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paneForSession,
  runSupervisionTick,
  supervisionDirPath,
  type PushFn,
  type TypeFn,
} from "./supervision.js";
import { recordSessionMapEntry, resolveSpawnerSession } from "./scope.js";
import type { WorkerStatus } from "./status.js";

const NOW = new Date("2026-10-17T10:00:00");
const LATER = new Date(NOW.getTime() + 90_000);

function worker(id: string, state: WorkerStatus["state"], extra: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    id,
    label: id,
    state,
    rc: state === "failed" ? 1 : null,
    pid: 1,
    updated: "2026-10-17 10:00:00",
    turns: 1,
    ...extra,
  } as unknown as WorkerStatus;
}

describe("alert isolation between sessions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-iso-"));
    const t = Date.now();
    writeFileSync(
      join(dir, "claude-session-map.json"),
      JSON.stringify({
        "/a\u0000sess-A": { session: "sess-A", ts: t, cwd: "/a", term: "w0t0p0:AAAAAAAA-0000-4000-8000-00000000000A" },
        "/b\u0000sess-B": { session: "sess-B", ts: t, cwd: "/b", term: "w0t1p0:AAAAAAAA-0000-4000-8000-00000000000B" },
      })
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function run(statuses: WorkerStatus[], at: Date, o: { push?: PushFn; type?: TypeFn } = {}) {
    const push = vi.fn<PushFn>(o.push ?? (async () => true));
    const type = vi.fn<TypeFn>(o.type ?? (async () => true));
    await runSupervisionTick(dir, {
      now: at,
      isAlive: () => true,
      push,
      statuses,
      pointer: { type, inputFree: async () => true, enabled: true },
    });
    return { push, type };
  }

  it("a nested worker alerts the orchestrator's session pane, never another session", async () => {
    // unit spawned by a tier-2 orchestrator inherits the orchestrator's spawnerSession
    const unit = (state: WorkerStatus["state"]) =>
      worker("unit-1", state, { spawnerSession: "sess-A", parent: "orch-1" } as Partial<WorkerStatus>);
    await run([unit("running")], NOW, { push: async () => false });
    const push = vi.fn<PushFn>(async () => true);
    await run([unit("failed")], NOW, { push });
    expect(push).toHaveBeenCalled();
    for (const c of push.mock.calls) expect(c[1].claudeSession).toBe("sess-A");
    expect(existsSync(join(supervisionDirPath(dir), "sess-B.events"))).toBe(false);
  });

  it("pointer types only into the owning session's pane; session B gets nothing", async () => {
    const w = (state: WorkerStatus["state"]) => worker("unit-2", state, { spawnerSession: "sess-A" });
    const nopush = { push: async () => false };
    await run([w("running")], NOW, nopush);
    await run([w("failed")], NOW, nopush);
    const { type } = await run([w("failed")], LATER, nopush);
    expect(type).toHaveBeenCalledTimes(1);
    expect(type.mock.calls[0][0]).toBe("AAAAAAAA-0000-4000-8000-00000000000A");
  });

  it("unresolvable target: skipped and logged, nothing typed anywhere", async () => {
    const w = (state: WorkerStatus["state"]) => worker("unit-3", state, { spawnerSession: "sess-GONE" });
    const nopush = { push: async () => false };
    await run([w("running")], NOW, nopush);
    await run([w("failed")], NOW, nopush);
    const { type } = await run([w("failed")], LATER, nopush);
    expect(type).not.toHaveBeenCalled();
    expect(readFileSync(join(supervisionDirPath(dir), "skipped.log"), "utf8")).toContain("sess-GONE");
  });

  it("paneForSession refuses a worker whose spawner differs from the event file's session", () => {
    const w = worker("x", "failed", { spawnerSession: "sess-A", session: { id: "AAAAAAAA-0000-4000-8000-00000000000A", name: "" } as never });
    expect(paneForSession(dir, "sess-A", w)).toBe("AAAAAAAA-0000-4000-8000-00000000000A");
    expect(paneForSession(dir, "sess-B", w)).toBeNull();
    expect(paneForSession(dir, "sess-B")).toBe("AAAAAAAA-0000-4000-8000-00000000000B");
    expect(paneForSession(dir, "nobody")).toBeNull();
  });

  it("two sessions in one cwd: spawner resolved by own pane, else ambiguous -> null", () => {
    const d = mkdtempSync(join(tmpdir(), "pai-iso2-"));
    const t0 = 1_700_000_000_000;
    recordSessionMapEntry(d, "/same", "sess-A", "w0t0p0:AAAAAAAA-0000-4000-8000-00000000000A", t0);
    recordSessionMapEntry(d, "/same", "sess-J", "w0t1p0:AAAAAAAA-0000-4000-8000-00000000000J", t0 + 1000);
    expect(resolveSpawnerSession(d, "/same", { ITERM_SESSION_ID: "w0t0p0:AAAAAAAA-0000-4000-8000-00000000000A" }, t0 + 2000)).toBe("sess-A");
    expect(resolveSpawnerSession(d, "/same", {}, t0 + 2000)).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });
});
