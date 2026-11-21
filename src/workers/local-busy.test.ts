import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeServedModels } from "./served-models.js";
import { pickLocal } from "./local-provider.js";
import { routeRun } from "./policy.js";
import { resolveTarget } from "./routing.js";
import type { WorkersConfig } from "./config.js";

const prov = (url: string, model: string) => ({ baseUrl: url, enabled: true, models: { default: model, fast: model }, tags: [] });

function cfg(): WorkersConfig {
  return {
    providers: { "gyro-l": prov("http://127.0.0.1:8035", "m-gyro"), "apple-fm": prov("http://127.0.0.1:11435", "apple-fm") },
    classes: {},
    routing: { policy: "order" },
    tiers: [{ id: "t2", name: "W", models: ["gyro-l", "apple-fm"], classes: ["implement"], default: true }],
  } as unknown as WorkersConfig;
}

const reset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

afterEach(() => vi.unstubAllGlobals());

describe("a busy or full local model is running", () => {
  it("a reset connection (engine at its cap) is retried until it answers", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      if (n++ < 2) throw reset();
      return new Response(JSON.stringify({ data: [{ id: "m-gyro" }] }), { status: 200 });
    });
    expect(await probeServedModels("127.0.0.1", 8035, 100)).toEqual({ alive: true, ids: ["m-gyro"] });
  });

  it("a persistent reset is busy (alive); a refused connection is down", async () => {
    vi.stubGlobal("fetch", async () => {
      throw reset();
    });
    expect((await probeServedModels("127.0.0.1", 8035, 100)).alive).toBe(true);
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect((await probeServedModels("127.0.0.1", 8035, 100)).alive).toBe(false);
  });

  it("gyro-l reachable with a stale pid file routes to gyro-l, never the cloud (the gate queues it at the cap)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-busy-"));
    writeFileSync(join(dir, "gyro-l.pid"), "999999\n");
    const r = await routeRun(cfg(), dir, { className: "implement" }, { ping: async () => true });
    expect(r?.providerFlag).toBe("gyro-l");
    expect(r?.route.local).toBe(true);
  });

  it("--local prefers the configured primary gyro-l over apple-fm when both are up", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-busy-"));
    const y = join(dir, "workers.yaml");
    writeFileSync(y, "local: gyro-l\n");
    expect(pickLocal(["apple-fm", "gyro-l"], dir, y, []).name).toBe("gyro-l");
    expect(pickLocal(["apple-fm", "gyro-l"], dir, y, ["gyro-l", "apple-fm"]).name).toBe("gyro-l");
  });

  it("a local entry left out on purpose (--cloud) is not reported as 'not running'; a down server says 'local down'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-busy-"));
    const c = { ...cfg(), tiers: [{ id: "t2", name: "W", models: ["gyro-l", "anthropic/sonnet"], classes: ["implement"], default: true }] } as unknown as WorkersConfig;
    const cloud = await routeRun(c, dir, { className: "implement", cloud: true }, { ping: async () => true });
    expect(cloud?.route.local).toBe(false);
    const t = resolveTarget(c, dir, { className: "implement", localWhy: cloud!.route.reason });
    expect(t.providerName).toBe("anthropic");
    expect(t.routeWhy).toContain("gyro-l: local (--cloud)");
    expect(t.routeWhy).not.toContain("not running");
    const down = await routeRun(c, dir, { className: "implement" }, { ping: async () => false });
    expect(down?.route.reason).toBe("route: cloud (local down)");
    const up = await routeRun(c, dir, { className: "implement" }, { ping: async () => true });
    expect(up?.providerFlag).toBe("gyro-l");
  });
});

describe("queue provider", () => {
  it("a queue run never names a loopback provider; it resolves local at run start", async () => {
    const { queueProviderName } = await import("./local-provider.js");
    const w = { ...cfg(), providers: { ...cfg().providers, cloud: { ...prov("https://api.example.com", "m"), enabled: true } } } as unknown as WorkersConfig;
    expect(queueProviderName(w, undefined)).toBe("local");
    expect(queueProviderName(w, "apple-fm")).toBe("local");
    expect(queueProviderName(w, "gyro-l")).toBe("local");
    expect(queueProviderName(w, "cloud")).toBe("cloud");
  });
});
