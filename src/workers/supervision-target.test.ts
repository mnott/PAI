import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bareItermUuid,
  pointUndrained,
  runSupervisionTick,
  supervisionDirPath,
  type TypeFn,
} from "./supervision.js";
import type { WorkerStatus } from "./status.js";

const UUID = "CEFF8DB4-BA5C-4838-9ADC-8BC12E054504";
const NOW = new Date("2026-10-17T10:00:00");
const LATER = new Date(NOW.getTime() + 90_000);

function worker(state: WorkerStatus["state"], spawnerSession: string): WorkerStatus {
  return {
    id: `w-${spawnerSession}`,
    label: "w",
    state,
    rc: state === "failed" ? 1 : null,
    pid: 1,
    updated: "2026-10-17 10:00:00",
    turns: 1,
    spawnerSession,
  } as unknown as WorkerStatus;
}

describe("pointer target and switch", () => {
  let dir: string;
  const mapTerm = (term: string, sessions = ["sess-A"]) =>
    writeFileSync(
      join(dir, "claude-session-map.json"),
      JSON.stringify(
        Object.fromEntries(
          sessions.map((s) => [`/x\u0000${s}`, { session: s, ts: Date.now(), cwd: "/x", term }])
        )
      )
    );
  const seed = async (sessions = ["sess-A"]) => {
    const base = { isAlive: () => true, push: async () => false };
    await runSupervisionTick(dir, { ...base, now: NOW, statuses: sessions.map((s) => worker("running", s)) });
    await runSupervisionTick(dir, { ...base, now: NOW, statuses: sessions.map((s) => worker("failed", s)) });
  };
  const point = (statuses: WorkerStatus[], type: TypeFn, enabled = true) =>
    pointUndrained(dir, {} as never, statuses, LATER, { type, inputFree: async () => true, enabled });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-tgt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("switch off: nothing is typed", async () => {
    mapTerm(`w5t0p0:${UUID}`);
    await seed();
    const type = vi.fn<TypeFn>(async () => true);
    expect(await point([worker("failed", "sess-A")], type, false)).toEqual([]);
    expect(type).not.toHaveBeenCalled();
  });

  it("a prefixed term reaches send as the bare UUID", async () => {
    mapTerm(`w5t0p0:${UUID}`);
    await seed();
    const type = vi.fn<TypeFn>(async () => true);
    await point([worker("failed", "sess-A")], type);
    expect(type).toHaveBeenCalledTimes(1);
    expect(type.mock.calls[0][0]).toBe(UUID);
  });

  it("a non-UUID target is skipped and logged", async () => {
    mapTerm("w5t0p0:my-tab-name");
    await seed();
    const type = vi.fn<TypeFn>(async () => true);
    await point([worker("failed", "sess-A")], type);
    expect(type).not.toHaveBeenCalled();
    expect(readFileSync(join(supervisionDirPath(dir), "skipped.log"), "utf8")).toContain("not an iTerm2 session UUID");
    expect(bareItermUuid("3")).toBeNull();
    expect(bareItermUuid(`w1t2p3:${UUID}`)).toBe(UUID);
  });

  it("two sessions on one pane get one notice per pass", async () => {
    mapTerm(`w5t0p0:${UUID}`, ["sess-A", "sess-B"]);
    await seed(["sess-A", "sess-B"]);
    const type = vi.fn<TypeFn>(async () => true);
    await point([worker("failed", "sess-A"), worker("failed", "sess-B")], type);
    expect(type).toHaveBeenCalledTimes(1);
  });

  it("overlapping passes announce once", async () => {
    mapTerm(`w5t0p0:${UUID}`);
    await seed();
    const type = vi.fn<TypeFn>(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return true;
    });
    const st = [worker("failed", "sess-A")];
    await Promise.all([point(st, type), point(st, type)]);
    expect(type).toHaveBeenCalledTimes(1);
  });
});
