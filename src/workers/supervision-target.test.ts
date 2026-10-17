import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("push receipts after a backlog summary", () => {
  let dir: string;
  const KEY = "CC813743-1111-2222-3333-444455556666";
  const seedStale = (n: number) => {
    const sdir = supervisionDirPath(dir);
    mkdirSync(sdir, { recursive: true });
    const lines = Array.from({ length: n }, (_, i) =>
      JSON.stringify({ id: `w#e${i}`, ts: "2026-10-17 07:00:00", kind: "failed", worker: "w-x", label: "w", session: KEY, rc: 1, stalledMin: null, text: "t" })
    );
    writeFileSync(join(sdir, `${KEY}.events`), lines.join("\n") + "\n");
    writeFileSync(
      join(dir, "claude-session-map.json"),
      JSON.stringify({ [`/x\u0000${KEY}`]: { session: KEY, ts: Date.now(), cwd: "/x", term: `w5t0p0:${UUID}` } })
    );
  };
  const run = (type: TypeFn) =>
    pointUndrained(dir, {} as never, [], LATER, { type, inputFree: async () => true, enabled: true });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-rcpt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the summary line writes one receipt per event, under the key the events were read from", async () => {
    seedStale(12);
    const type = vi.fn<TypeFn>(async () => true);
    expect(await run(type)).toEqual([KEY]);
    expect(type.mock.calls[0][1]).toContain("12 older worker events skipped");
    const receipts = readFileSync(join(supervisionDirPath(dir), `${KEY}.pushed`), "utf8").split("\n").filter(Boolean);
    expect(receipts).toHaveLength(12);
    expect(await run(type)).toEqual([]); // nothing announced twice
  });

  it("a receipt write that fails is logged, not swallowed", async () => {
    seedStale(12);
    mkdirSync(join(supervisionDirPath(dir), `${KEY}.pushed`)); // appendFileSync on a directory throws EISDIR
    await run(vi.fn<TypeFn>(async () => true));
    expect(readFileSync(join(supervisionDirPath(dir), "skipped.log"), "utf8")).toContain("receipt write failed");
  });
});

describe("repeat-loop alerts", () => {
  let dir: string;
  const failing = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      { type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: true, content: "No changes to make" }] } },
    ]).flat();
  const base = { isAlive: () => true, push: async () => false };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-loop-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pushes one looping alert at 3 identical failures and injects the correction once", async () => {
    const w = { ...worker("running", "sess-A"), provider: "local30x8" } as WorkerStatus;
    const say = vi.fn(async () => "ok");
    const kill = vi.fn();
    const loops = { readEvents: () => failing(3), say, kill };
    await runSupervisionTick(dir, { ...base, now: NOW, statuses: [w], loops }); // first run baselines the state
    const r = await runSupervisionTick(dir, { ...base, now: NOW, statuses: [w], loops });
    const looping = r.events.filter((e) => e.kind === "looping");
    expect(looping).toHaveLength(1);
    expect(looping[0].text).toContain("looping: 3x identical failing Edit call");
    expect(say).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    const again = await runSupervisionTick(dir, { ...base, now: NOW, statuses: [w], loops });
    expect(again.events.filter((e) => e.kind === "looping")).toHaveLength(0);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("stops the run at 6 identical failures", async () => {
    const w = { ...worker("running", "sess-A"), provider: "local30x8", pid: 4242 } as WorkerStatus;
    const kill = vi.fn();
    const loops = { readEvents: () => failing(6), say: async () => "ok", kill };
    await runSupervisionTick(dir, { ...base, now: NOW, statuses: [w], loops });
    const r = await runSupervisionTick(dir, { ...base, now: NOW, statuses: [w], loops });
    expect(kill).toHaveBeenCalledWith(4242);
    expect(r.events.some((e) => e.kind === "looping" && e.text.includes("run stopped"))).toBe(true);
  });
});
