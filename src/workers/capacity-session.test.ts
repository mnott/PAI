import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CAPACITY, capacityGate, providerCap, resolveCap, sessionScopeKey, type CapacityOpts } from "./capacity.js";
import { getProfile, updateProfile } from "./session-profile-store.js";
import type { WorkerStatus } from "./status.js";

const st = (id: string, over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: 100, provider: "cloud", state: "running", turns: 0, origin: "spawn", ...over }) as WorkerStatus;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function harness(statuses: (ms: number) => WorkerStatus[], self: WorkerStatus, session: string | undefined, max: number | undefined) {
  const logDir = mkdtempSync(join(tmpdir(), "capsess-"));
  dirs.push(logDir);
  let t = 0;
  const lines: string[] = [];
  const opts: CapacityOpts = {
    logDir,
    self: { id: self.id, provider: self.provider, pid: 200 },
    cap: undefined, // cloud provider: unlimited
    config: DEFAULT_CAPACITY,
    log: (l) => lines.push(l),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    load: () => statuses(t),
    isAlive: () => true,
    ...(session && max
      ? { scope: { key: sessionScopeKey(session), label: `session ${session}`, holds: (s: WorkerStatus) => s.sessionKey === session }, cap: max }
      : {}),
  };
  return { opts, lines, elapsed: () => t };
}

describe("provider cap is the model's default concurrency, independent of loopback", () => {
  it("explicit cap wins on either side of loopback; loopback alone is not serial", () => {
    expect(resolveCap(1, false)).toBe(1); // a cloud model can be serial
    expect(resolveCap(1, true)).toBe(1);
    expect(resolveCap(6, true)).toBe(6); // a parallel-capable local server
    expect(resolveCap(undefined, true)).toBeGreaterThan(1);
    expect(resolveCap(undefined, false)).toBeUndefined();
  });

  it("providerCap reads maxConcurrent, not the URL", () => {
    const config = {
      providers: {
        serialCloud: { baseUrl: "https://api.example.com", maxConcurrent: 1 },
        parallelLocal: { baseUrl: "http://127.0.0.1:8000", maxConcurrent: 4 },
        serialLocal: { baseUrl: "http://127.0.0.1:8001", maxConcurrent: 1 },
      },
    };
    expect(providerCap(config, "serialCloud")).toBe(1);
    expect(providerCap(config, "parallelLocal")).toBe(4);
    expect(providerCap(config, "serialLocal")).toBe(1);
  });
});

describe("session max_parallel", () => {
  it("serialises two cloud workers of the same session", async () => {
    const h = harness((ms) => [st("a", { sessionKey: "s1", state: ms >= 3000 ? "done" : "running" }), st("b", { sessionKey: "s1" })], st("b", { sessionKey: "s1" }), "s1", 1);
    const r = await capacityGate(h.opts);
    expect(r?.cap).toBe(1);
    expect(h.lines[0]).toBe("queued: 2 on session s1, cap 1 (position 1)");
    expect(h.elapsed()).toBeGreaterThanOrEqual(3000);
  });

  it("does not hold another session's worker", async () => {
    const h = harness(() => [st("a", { sessionKey: "s1" }), st("c", { sessionKey: "s2" })], st("c", { sessionKey: "s2" }), "s2", 1);
    expect(await capacityGate(h.opts)).toBeNull();
    expect(h.elapsed()).toBe(0);
  });

  it("holds across providers", async () => {
    const h = harness(() => [st("a", { sessionKey: "s1", provider: "other" }), st("b", { sessionKey: "s1" })], st("b", { sessionKey: "s1" }), "s1", 1);
    let n = 0;
    const load = h.opts.load!;
    h.opts.load = (d) => (++n > 2 ? [] : load(d));
    const r = await capacityGate(h.opts);
    expect(r).not.toBeNull();
  });

  it("unset restores parallel", async () => {
    const home = mkdtempSync(join(tmpdir(), "capsess-prof-"));
    dirs.push(home);
    const path = join(home, "session-profiles.yaml");
    updateProfile("s1", { max_parallel: 1 }, path);
    expect(getProfile("s1", path)?.max_parallel).toBe(1);
    updateProfile("s1", { max_parallel: null }, path);
    expect(getProfile("s1", path)?.max_parallel).toBeUndefined();
    // no session cap and an unlimited provider: the second worker passes at once
    const h = harness(() => [st("a", { sessionKey: "s1" }), st("b", { sessionKey: "s1" })], st("b", { sessionKey: "s1" }), "s1", getProfile("s1", path)?.max_parallel);
    expect(await capacityGate(h.opts)).toBeNull();
  });
});
