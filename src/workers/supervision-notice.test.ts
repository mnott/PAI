import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectSupervisionEvents,
  runSupervisionTick,
  supervisionEventsPath,
  supervisionPushedPath,
  type SupervisionEvent,
  type TypeFn,
} from "./supervision.js";
import type { WorkerStatus } from "./status.js";

const NOW = new Date("2026-10-17T10:00:00");
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

function ev(i: number, ts: Date, session = "sess-1"): SupervisionEvent {
  return { id: `w-${i}#stalled@${i}`, ts: stamp(ts), kind: "stalled", worker: "w-ptr", label: "x", session, rc: null, stalledMin: 5, text: "t" };
}

const owner = {
  id: "w-ptr", label: "ptr", state: "failed", rc: 1, pid: 1, spawnerSession: "sess-1",
  session: { id: "ITERM" }, updated: "2026-10-17 10:00:00", turns: 1,
} as unknown as WorkerStatus;

describe("pointer notices are delivery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-notice-"));
    mkdirSync(join(dir, "supervision"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = (events: SupervisionEvent[]) =>
    appendFileSync(supervisionEventsPath(dir, "sess-1"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const tick = (at: Date, type: ReturnType<typeof vi.fn<TypeFn>>) =>
    runSupervisionTick(dir, {
      now: at, isAlive: () => true, push: async () => false, statuses: [owner],
      pointer: { type, inputFree: async () => true },
    });
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  it("a notice writes receipts; no repeat even after the 24 h pointered expiry", async () => {
    seed([ev(1, NOW), ev(2, NOW), ev(3, NOW)]);
    const type = vi.fn<TypeFn>(async () => true);
    await tick(later(90_000), type);
    expect(type).toHaveBeenCalledTimes(1);
    expect(String(type.mock.calls[0][1])).toContain("3 worker alerts pending");
    expect(readFileSync(supervisionPushedPath(dir, "sess-1"), "utf8").trim().split("\n")).toHaveLength(3);
    await tick(later(90_000 + 120_000), type);
    await tick(later(2 * 86_400_000), type); // pointered map long pruned
    expect(type).toHaveBeenCalledTimes(1);
  });

  it("a backlog of old events becomes one summary and is skipped for good", async () => {
    const old = new Date(NOW.getTime() - 5 * 3_600_000);
    seed(Array.from({ length: 50 }, (_, i) => ev(i, old)));
    const type = vi.fn<TypeFn>(async () => true);
    await tick(NOW, type);
    expect(type).toHaveBeenCalledTimes(1);
    expect(String(type.mock.calls[0][1])).toContain("50 older worker events skipped");
    await tick(later(120_000), type);
    expect(type).toHaveBeenCalledTimes(1);
  });

  it("an event of another session in the file is skipped", async () => {
    seed([ev(1, NOW, "other-sess")]);
    const type = vi.fn<TypeFn>(async () => true);
    await tick(later(90_000), type);
    expect(type).not.toHaveBeenCalled();
  });
});

describe("hollow registrations", () => {
  it("a dead zero-turn run older than 10 min raises no alert", () => {
    const hollow = { ...owner, state: "running", pid: 99999999, turns: 0, rc: null, updated: "2026-10-17 09:00:00" } as unknown as WorkerStatus;
    const opts = { now: NOW, stallMs: 1e9, isAlive: () => false };
    expect(detectSupervisionEvents([hollow], opts)).toEqual([]);
    const ran = { ...hollow, turns: 3 } as WorkerStatus;
    expect(detectSupervisionEvents([ran], opts)).toHaveLength(1);
  });
});
