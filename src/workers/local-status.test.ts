import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkersConfig } from "./config.js";
import { computeLocalStatus, resolveLocalProvider } from "./local-provider.js";
import { localStatusLine, readLocalStatus, writeLocalStatus, type LocalStatus } from "./local-status.js";

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
    expect(st.running).toEqual({ provider: "flashnext-iq3", model: "qwen3.8-flash-next-iq3_s", why: "only local server up" });
    expect(st.down).toEqual(["local30"]);
    expect(st.disabled).toEqual(["old"]);
    expect(localStatusLine(st)).toBe(
      "local: flashnext-iq3 (qwen3.8-flash-next-iq3_s) running — use `pai worker run --local`"
    );
  });

  it("says none running and not to start servers when nothing answers", async () => {
    const st = await computeLocalStatus(cfg, tmp(), { check: async () => false });
    expect(st.running).toBeNull();
    expect(localStatusLine(st)).toBe("local: none running — local work is not available; do not start model servers");
  });
});

describe("cache", () => {
  const st: LocalStatus = { at: new Date(1_000_000).toISOString(), running: null, down: [], disabled: [] };

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
      running: { provider: "local30", model: "big", why: "only local server up" },
      down: [],
      disabled: [],
    });
    expect((await resolveLocalProvider(cfg, dir)).name).toBe("local30");
  });

  it("a fresh cache saying none running refuses with the do-not-start message", async () => {
    const dir = tmp();
    writeLocalStatus(dir, { at: new Date().toISOString(), running: null, down: [], disabled: [] });
    await expect(resolveLocalProvider(cfg, dir)).rejects.toThrow(/do not start model servers/);
  });
});
