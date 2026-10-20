import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseLocalConfig, planStart } from "../../workers/local-tiers.js";
import { startTier } from "./worker-config.js";

describe("startTier", () => {
  it("stops first, then points workers.yaml local: at the tier and writes LOCAL-SWITCH", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-switch-"));
    const yaml = join(d, "workers.yaml");
    writeFileSync(yaml, "# keep me\nlocal: old\nproviders: {}\n");
    const ledger = join(d, "ledger.log");
    const cfg = parseLocalConfig(
      { local_tiers: { iq3s: { engine: "script", provider: "flashnext-iq3", start: "/x.sh", port: 8035, label: "IQ3" }, gyro: { engine: "script", provider: "gyro-m", start: "/y.sh", port: 8035 } } },
      { "flashnext-iq3": { model: "m1" }, "gyro-m": { model: "m2" } },
    );
    const order: string[] = [];
    let polls = 0;
    await startTier(cfg, "iq3s", cfg.tiers.iq3s, planStart(cfg, cfg.tiers.iq3s), {
      yamlPath: yaml,
      ledger,
      pollMs: 1,
      current: async () => cfg.tiers.gyro,
      stop: async () => void order.push("stop"),
      launch: () => (order.push("launch"), () => null),
      up: async () => ++polls > 2,
    });
    expect(order).toEqual(["stop", "launch"]);
    const text = readFileSync(yaml, "utf8");
    expect(text).toContain("# keep me");
    expect((parse(text) as { local: string }).local).toBe("flashnext-iq3");
    expect(readFileSync(ledger, "utf8")).toMatch(/LOCAL-SWITCH from=gyro to=iq3s provider=flashnext-iq3/);
  });

  it("does not touch local: when the server exits before it answers", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-switch-"));
    const yaml = join(d, "workers.yaml");
    writeFileSync(yaml, "local: old\n");
    const cfg = parseLocalConfig({ local_tiers: { s: { engine: "script", provider: "p", start: "/x.sh", port: 1 } } }, {});
    await expect(
      startTier(cfg, "s", cfg.tiers.s, planStart(cfg, cfg.tiers.s), { yamlPath: yaml, ledger: join(d, "l"), pollMs: 1, current: async () => null, stop: async () => {}, launch: () => () => 3, up: async () => false }),
    ).rejects.toThrow(/exited \(3\)/);
    expect(readFileSync(yaml, "utf8")).toBe("local: old\n");
  });
});
