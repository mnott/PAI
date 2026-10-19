import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_ANTHROPIC_MODELS, type WorkersConfig } from "./config.js";
import {
  PORT_TIMEOUT_MS,
  probeLoopback,
  readLocalPreference,
  resolveLocalProvider,
  resolvePlanProvider,
  type PortCheck,
} from "./local-provider.js";

const prov = (baseUrl: string, enabled = true) => ({
  enabled,
  protocol: "anthropic" as const,
  baseUrl,
  keyFile: null,
  env: {},
  models: { default: "m", fast: "f" },
});

const cfg = {
  providers: {
    remote: prov("https://api.example.invalid"),
    up: prov("http://127.0.0.1:8035"),
    also: prov("http://localhost:8011"),
    dead: prov("http://localhost:8001"),
    off: prov("http://localhost:9000", false),
  },
} as unknown as Pick<WorkersConfig, "providers">;

/** Only 8035 answers; the probe records host, port and timeout. */
const only8035: PortCheck = async (_h, port) => port === 8035;
const bothUp: PortCheck = async (_h, port) => port === 8035 || port === 8011;
const noneUp: PortCheck = async () => false;

const tmp = () => mkdtempSync(join(tmpdir(), "localprov-"));

describe("probeLoopback", () => {
  it("probes only enabled loopback providers, in parallel, with a short timeout", async () => {
    const calls: Array<[string, number, number]> = [];
    const running = await probeLoopback(cfg, async (h, p, t) => {
      calls.push([h, p, t]);
      return p === 8035;
    });
    expect(running).toEqual({ up: true, also: false, dead: false });
    expect(calls).toHaveLength(3);
    expect(calls.every(([, , t]) => t === PORT_TIMEOUT_MS)).toBe(true);
    expect(calls.map(([h]) => h).sort()).toEqual(["127.0.0.1", "localhost", "localhost"]);
  });
});

describe("resolveLocalProvider", () => {
  it("exactly one up: it, and the why says so", async () => {
    const r = await resolveLocalProvider(cfg, tmp(), { check: only8035 });
    expect(r).toEqual({ name: "up", why: "only local server up" });
  });

  it("several up, no local: key: the one most recently started/used", async () => {
    const dir = tmp();
    const st = (id: string, provider: string, updated: string) =>
      writeFileSync(join(dir, `${id}.status`), JSON.stringify({ id, provider, started: "2026-10-19 09:00:00", updated }));
    st("w-20261019-090000-1", "also", "2026-10-19 09:30:00");
    st("w-20261019-100000-2", "up", "2026-10-19 13:45:00");
    const r = await resolveLocalProvider(cfg, dir, { check: bothUp, yamlPath: join(dir, "workers.yaml") });
    expect(r).toEqual({ name: "up", why: "most recently started/used" });
  });

  it("several up with a workers.yaml local: key: that one, and the why says so", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "workers.yaml"), "active: anthropic\nlocal: also\nproviders:\n  anthropic:\n    builtin: true\n");
    const r = await resolveLocalProvider(cfg, dir, { check: bothUp, yamlPath: join(dir, "workers.yaml") });
    expect(r).toEqual({ name: "also", why: "workers.yaml local:" });
  });

  it("a local: key naming a provider that is not running is an error", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "workers.yaml"), "local: dead\n");
    await expect(
      resolveLocalProvider(cfg, dir, { check: bothUp, yamlPath: join(dir, "workers.yaml") })
    ).rejects.toThrow(/local: names "dead", but it is not a running local provider/);
  });

  it("none up: an error naming that no local model server is running", async () => {
    await expect(resolveLocalProvider(cfg, tmp(), { check: noneUp })).rejects.toThrow(
      /no local model server is running/
    );
  });

  it("resolvePlanProvider passes a named provider through and resolves `local`", async () => {
    const full = { ...(cfg as object), active: null, nativeModels: { ...NATIVE_ANTHROPIC_MODELS } } as WorkersConfig;
    expect(await resolvePlanProvider(full, tmp(), "glm")).toBe("glm");
    expect(await resolvePlanProvider(full, tmp(), "local", { check: only8035 })).toBe("up");
  });
});

describe("readLocalPreference", () => {
  it("reads the top-level local: key; absent or broken files give undefined", () => {
    const dir = tmp();
    expect(readLocalPreference(join(dir, "nope.yaml"))).toBeUndefined();
    writeFileSync(join(dir, "a.yaml"), "active: anthropic\nlocal: glm\n");
    expect(readLocalPreference(join(dir, "a.yaml"))).toBe("glm");
    writeFileSync(join(dir, "b.yaml"), "local:\n  nested: true\n");
    expect(readLocalPreference(join(dir, "b.yaml"))).toBeUndefined();
    writeFileSync(join(dir, "c.yaml"), "local: flashnext-iq3  # the Strata server\n");
    expect(readLocalPreference(join(dir, "c.yaml"))).toBe("flashnext-iq3");
  });
});
