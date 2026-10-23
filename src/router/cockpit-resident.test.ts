import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { weightsBytes } from "./cockpit-weights.js";
import { registryModels } from "./cockpit-registry-models.js";
import type { LocalConfig, LocalTier } from "../workers/local-tiers.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const gbm = (m: number) => (m / 1024).toFixed(1);
const GB = 1024 ** 3;
import { WIN_CLOUD_JS } from "./cockpit-page/win/cards-cloud.js";
const fn = (name: string) => (name === "limResident" || name === "limServerHtml" || name === "limEngineHtml" ? WIN_CLOUD_JS : COCKPIT_HTML).match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))![0];
const residentOf = new Function("gbm", `${fn("limResident")}\nreturn limResident;`)(gbm) as (r: number | null, w?: number) => { txt: string; note: string };
const server = new Function("esc", "gbm", "shortModel", "limResident", `${fn("limEngineHtml")}\n${fn("limServerHtml")}\nreturn limServerHtml;`)(esc, gbm, (s: string) => s, residentOf) as (l: unknown) => string;

const NOTE = "partly paged out";
const up = (rssMb: number, weightsBytes: number) => ({ provider: "p", kind: "local", up: true, rssMb, weightsBytes, served: ["m"] });

describe("resident memory against weight size", () => {
  it("0.6 GB resident of 30 GB: shown with the paged-out note", () => {
    const h = server(up(614, 30 * GB));
    expect(h).toContain("resident 0.6 GB of 30.0 GB");
    expect(h).toContain(NOTE);
  });
  it("29 of 30 GB: no note", () => {
    const h = server(up(29 * 1024, 30 * GB));
    expect(h).toContain("resident 29.0 GB of 30.0 GB");
    expect(h).not.toContain(NOTE);
  });
  it("stopped server: no memory row, no note", () => {
    const h = server({ provider: "p", kind: "local", up: false, starting: { state: "failed", message: "x", log: "" } });
    expect(h).not.toContain("resident");
    expect(h).not.toContain(NOTE);
  });
  it("unknown weight size: plain memory", () => {
    expect(residentOf(5000, undefined)).toEqual({ txt: "4.9 GB", note: "" });
  });
});

describe("weightsBytes", () => {
  it("sums the weight args of a Strata config and the registry carries it", () => {
    const d = mkdtempSync(join(tmpdir(), "wb-"));
    try {
      mkdirSync(join(d, "pack"));
      writeFileSync(join(d, "pack/a.bin"), Buffer.alloc(1000));
      writeFileSync(join(d, "m.gguf"), Buffer.alloc(5000));
      writeFileSync(join(d, "other.bin"), Buffer.alloc(77));
      const cfg = join(d, "s.json");
      writeFileSync(cfg, JSON.stringify({ args: ["--pack", join(d, "pack"), "--native", join(d, "m.gguf"), "--expert-profile", join(d, "other.bin")] }));
      const t = { tier: "t", engine: "strata", model: "", config: cfg, port: 1, maxInstances: 1 } as unknown as LocalTier;
      expect(weightsBytes(t)).toBe(6000);
      const rm = registryModels({ tiers: { t } } as unknown as LocalConfig, [], weightsBytes);
      expect(rm[0]!.weightsBytes).toBe(6000);
      expect(registryModels({ tiers: { t } } as unknown as LocalConfig, [])[0]).not.toHaveProperty("weightsBytes");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("unreadable config: undefined", () => {
    expect(weightsBytes({ tier: "x", engine: "strata", model: "", config: "/nonexistent.json" } as unknown as LocalTier)).toBeUndefined();
  });
});
