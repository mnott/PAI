import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalProvider, type PortCheck } from "./local-provider.js";
import type { TierDef } from "./route-lists.js";

const prov = (baseUrl: string) => ({
  enabled: true, protocol: "anthropic" as const, baseUrl, keyFile: null, env: {}, models: { default: "m", fast: "f" },
});
const providers = {
  codernext4: prov("http://127.0.0.1:8011"),
  "gyro-m": prov("http://127.0.0.1:8035"),
};
const tier = (models: string[]): TierDef[] => [{ id: "t2", name: "Worker", models, classes: ["implement"] }];
const bothUp: PortCheck = async () => true;
const dir = () => mkdtempSync(join(tmpdir(), "localtier-"));

describe("one rule: the first running local model in the tier order", () => {
  it("two running, tier lists gyro-m then codernext4: gyro-m, even against a local: key", async () => {
    const d = dir();
    writeFileSync(join(d, "workers.yaml"), "local: codernext4\n");
    const cfg = { providers, tiers: tier(["gyro-m", "anthropic", "codernext4"]) };
    const r = await resolveLocalProvider(cfg as never, d, { check: bothUp, yamlPath: join(d, "workers.yaml") });
    expect(r.name).toBe("gyro-m");
    const c = await resolveLocalProvider(cfg as never, d, { check: bothUp, yamlPath: join(d, "workers.yaml"), className: "implement" });
    expect(c.name).toBe("gyro-m");
  });

  it("tier lists none running: registry order", async () => {
    const d = dir();
    const cfg = { providers, tiers: tier(["anthropic", "glm"]) };
    const r = await resolveLocalProvider(cfg as never, d, { check: bothUp, yamlPath: join(d, "workers.yaml") });
    expect(r.name).toBe("codernext4");
  });

  it("--local codernext4: that one", async () => {
    const d = dir();
    const cfg = { providers, tiers: tier(["gyro-m", "codernext4"]) };
    const r = await resolveLocalProvider(cfg as never, d, { check: bothUp, yamlPath: join(d, "workers.yaml"), name: "codernext4" });
    expect(r.name).toBe("codernext4");
  });

  it("--local missing: an error listing the running ones", async () => {
    const d = dir();
    const cfg = { providers, tiers: tier(["gyro-m"]) };
    await expect(
      resolveLocalProvider(cfg as never, d, { check: bothUp, yamlPath: join(d, "workers.yaml"), name: "nope" })
    ).rejects.toThrow(/not a running local model \(running: codernext4, gyro-m\)/);
  });
});
