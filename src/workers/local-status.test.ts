import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkersConfig } from "./config.js";
import { computeLocalStatus, currentLocalStatus, resolveLocalInstances, resolveLocalProvider } from "./local-provider.js";
import { localStatusLine, primaryLocal, readLocalStatus, writeLocalStatus, type LocalStatus } from "./local-status.js";

const prov = (baseUrl: string, model: string, enabled = true) => ({
  enabled,
  protocol: "anthropic" as const,
  baseUrl,
  keyFile: null,
  env: {},
  models: { default: model, fast: model },
});

const cfg = {
  providers: {
    cloud: prov("https://api.example.invalid", "c"),
    "flashnext-iq3": prov("http://127.0.0.1:8035", "qwen3.8-flash-next-iq3_s"),
    local30: prov("http://127.0.0.1:8011", "big"),
    old: prov("http://127.0.0.1:8020", "old", false),
  },
} as unknown as Pick<WorkersConfig, "providers">;

const tmp = () => mkdtempSync(join(tmpdir(), "localstatus-"));

describe("computeLocalStatus", () => {
  it("names the running provider and model, lists down and disabled ones", async () => {
    const st = await computeLocalStatus(cfg, tmp(), { check: async (_h, port) => port === 8035 });
    expect(st.running).toEqual([{ provider: "flashnext-iq3", model: "qwen3.8-flash-next-iq3_s", why: "only local server up" }]);
    expect(st.down).toEqual(["local30"]);
    expect(st.disabled).toEqual(["old"]);
    expect(localStatusLine(st)).toBe(
      "local: flashnext-iq3 (qwen3.8-flash-next-iq3_s) running — use `pai worker run --local`"
    );
  });

  it("says none running and not to start servers when nothing answers", async () => {
    const st = await computeLocalStatus(cfg, tmp(), { check: async () => false });
    expect(st.running).toEqual([]);
    expect(localStatusLine(st)).toBe("local: none running — local work is not available; do not start model servers");
  });
});

describe("cache", () => {
  const st: LocalStatus = { at: new Date(1_000_000).toISOString(), running: [], down: [], disabled: [] };

  it("round-trips while fresh and goes null when stale or absent", () => {
    const dir = tmp();
    expect(readLocalStatus(dir)).toBeNull();
    writeLocalStatus(dir, st);
    expect(readLocalStatus(dir, 1_000_000 + 30_000)).toEqual(st);
    expect(readLocalStatus(dir, 1_000_000 + 91_000)).toBeNull();
  });

  it("resolveLocalProvider uses the fresh cached answer without probing", async () => {
    const dir = tmp();
    writeLocalStatus(dir, {
      at: new Date().toISOString(),
      running: [{ provider: "local30", model: "big", why: "only local server up" }],
      down: [],
      disabled: [],
    });
    expect((await resolveLocalProvider(cfg, dir)).name).toBe("local30");
  });

  it("resolveLocalProvider with nothing up refuses with the do-not-start message", async () => {
    await expect(resolveLocalProvider(cfg, tmp(), { check: async () => false })).rejects.toThrow(/do not start model servers/);
  });
});

describe("currentLocalStatus: none only after a fresh probe", () => {
  const up = async (_h: string, port: number) => port === 8035;
  const nothing = async () => false;

  it("missing cache + server up -> running", async () => {
    expect((await currentLocalStatus(tmp(), { cfg, check: up })).running[0]?.provider).toBe("flashnext-iq3");
  });

  it("stale cache saying none + server up -> running", async () => {
    const dir = tmp();
    writeLocalStatus(dir, { at: new Date(Date.now() - 600_000).toISOString(), running: [], down: [], disabled: [] });
    expect((await currentLocalStatus(dir, { cfg, check: up })).running[0]?.provider).toBe("flashnext-iq3");
  });

  it("fresh cache saying none + server up -> running", async () => {
    const dir = tmp();
    writeLocalStatus(dir, { at: new Date().toISOString(), running: [], down: [], disabled: [] });
    expect((await currentLocalStatus(dir, { cfg, check: up })).running[0]?.provider).toBe("flashnext-iq3");
  });

  it("all down -> none", async () => {
    expect((await currentLocalStatus(tmp(), { cfg, check: nothing })).running).toEqual([]);
  });
});

describe("running list", () => {
  it("an old cache with an object `running` reads as a one-element list", () => {
    const dir = tmp();
    const at = new Date().toISOString();
    writeFileSync(
      join(dir, "local-status.json"),
      JSON.stringify({ at, running: { provider: "local30", model: "big", why: "x" }, down: [], disabled: [] })
    );
    expect(readLocalStatus(dir)?.running).toEqual([{ provider: "local30", model: "big", why: "x" }]);
    expect(primaryLocal(readLocalStatus(dir))?.provider).toBe("local30");
  });

  it("several running models: all listed, the pick first; resolveLocalInstances falls back to the provider url", async () => {
    const dir = tmp();
    const st = await computeLocalStatus(cfg, dir, { check: async () => true, yamlPath: join(dir, "none.yaml") });
    expect(st.running.length).toBeGreaterThan(0);
    expect(localStatusLine(st)).toContain(st.running[0].provider);
    const inst = resolveLocalInstances(cfg, dir, st.running[0].provider);
    expect(inst).toHaveLength(1);
    expect(inst[0].url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
  });
});
