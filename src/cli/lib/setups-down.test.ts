import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { NATIVE_ANTHROPIC_MODELS } from "../../workers/config.js";
import { resolveSetup } from "../commands/root.js";
import { allSetups, downLocalProviders, httpModelsCheck, PORT_TIMEOUT_MS, type PortCheck } from "./setups.js";

const prov = (baseUrl: string, enabled = true) => ({ enabled, protocol: "anthropic" as const, baseUrl, keyFile: null, env: {}, models: { default: "m", fast: "f" } });
const cfg = {
  active: "glm",
  nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
  providers: {
    glm: prov("https://glm.invalid"),
    up: prov("http://127.0.0.1:8035"),
    dead: prov("http://localhost:8001"),
    off: prov("http://localhost:9000", false),
  },
  routing: { budgetWalls: {} },
} as never;

const check: PortCheck = async (_h, port) => port === 8035;

describe("local setups need a running server", () => {
  it("checks only enabled loopback providers, with host, port and a short timeout", async () => {
    const calls: Array<[string, number, number]> = [];
    const down = await downLocalProviders(cfg, async (h, p, t) => (calls.push([h, p, t]), p === 8035));
    expect([...down]).toEqual(["dead"]);
    expect(calls).toHaveLength(2);
    expect(calls.every(([, , t]) => t === PORT_TIMEOUT_MS)).toBe(true);
  });

  it("lists only up local providers", async () => {
    const down = await downLocalProviders(cfg, check);
    const names = allSetups(cfg, null, [], down).map((s) => s.name);
    expect(names).toContain("anthropic + local workers");
    expect(allSetups(cfg, null, [], down, "up").find((s) => s.local)?.workers).toBe("up");
    expect(names).not.toContain("anthropic + dead workers");
  });

  it("keeps Last time even when its workers are down", async () => {
    const down = await downLocalProviders(cfg, check);
    const last = { name: "Last time", orchestrator: { provider: "anthropic" }, workers: "dead", kind: "last" as const };
    expect(allSetups(cfg, last, [], down)[0].name).toBe("Last time");
  });

  it("--with a down local setup says so; an up one resolves", async () => {
    const down = await downLocalProviders(cfg, check);
    await expect(resolveSetup(cfg, null, "anthropic + dead workers", down)).rejects.toThrow(/local provider dead is not running; start it with/);
    await expect(resolveSetup(cfg, null, "anthropic + local workers", down)).resolves.toMatchObject({ workers: "up" });
  });
});

describe("httpModelsCheck", () => {
  const serve = (handler: (res: ServerResponse) => void) =>
    new Promise<{ port: number; close: () => void }>((resolve) => {
      const s = createServer((_req, res) => handler(res)).listen(0, "127.0.0.1", () =>
        resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }),
      );
    });

  it("running = 2xx with a JSON body; a listener that answers nothing or no JSON is not", async () => {
    const ok = await serve((r) => r.end('{"data":[]}'));
    const text = await serve((r) => r.end("hello"));
    const bad = await serve((r) => ((r.statusCode = 404), r.end("{}")));
    const silent = await serve(() => {});
    try {
      expect(await httpModelsCheck("127.0.0.1", ok.port, 500)).toBe(true);
      expect(await httpModelsCheck("127.0.0.1", text.port, 500)).toBe(false);
      expect(await httpModelsCheck("127.0.0.1", bad.port, 500)).toBe(false);
      expect(await httpModelsCheck("127.0.0.1", silent.port, 200)).toBe(false);
    } finally {
      [ok, text, bad, silent].forEach((s) => s.close());
    }
  });
});
