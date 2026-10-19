import { describe, expect, it } from "vitest";
import { NATIVE_ANTHROPIC_MODELS } from "../../workers/config.js";
import { resolveSetup } from "../commands/root.js";
import { allSetups, downLocalProviders, type PortCheck } from "./setups.js";

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
    expect(calls.every(([, , t]) => t === 150)).toBe(true);
  });

  it("lists only up local providers", async () => {
    const down = await downLocalProviders(cfg, check);
    const names = allSetups(cfg, null, [], down).map((s) => s.name);
    expect(names).toContain("anthropic + up workers");
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
    await expect(resolveSetup(cfg, null, "anthropic + up workers", down)).resolves.toMatchObject({ workers: "up" });
  });
});
