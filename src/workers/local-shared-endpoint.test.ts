import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkersConfig } from "./config.js";
import { computeLocalStatus, probeLoopback } from "./local-provider.js";
import { downLocalProviders } from "../cli/lib/setups.js";

const prov = (model: string) => ({
  enabled: true,
  protocol: "anthropic" as const,
  baseUrl: "http://127.0.0.1:8035",
  keyFile: null,
  env: {},
  models: { default: model, fast: model },
});

const cfg = {
  providers: { "iq3": prov("flash-iq3_s"), "gyro-m": prov("flash-gyro-m") },
} as unknown as Pick<WorkersConfig, "providers">;

/** One server on 8035 serving only the gyro-m model. */
function serve(ids: string[]): void {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }));
}

afterEach(() => vi.unstubAllGlobals());

describe("two providers on one endpoint", () => {
  it("only the one whose model is served is up, on every poll", async () => {
    serve(["flash-gyro-m"]);
    for (let i = 0; i < 3; i++) {
      expect(await probeLoopback(cfg)).toEqual({ iq3: false, "gyro-m": true });
      expect([...(await downLocalProviders(cfg as never))]).toEqual(["iq3"]);
    }
  });

  it("the daemon status runs on the served provider and lists the other as down", async () => {
    serve(["flash-gyro-m"]);
    const logDir = mkdtempSync(join(tmpdir(), "shared-ep-"));
    for (let i = 0; i < 3; i++) {
      const st = await computeLocalStatus(cfg, logDir, { yamlPath: join(logDir, "none.yaml") });
      expect(st.running[0]?.provider).toBe("gyro-m");
      expect(st.down).toEqual(["iq3"]);
    }
  });

  it("swapping the served model swaps which one is up", async () => {
    serve(["flash-iq3_s"]);
    expect(await probeLoopback(cfg)).toEqual({ iq3: true, "gyro-m": false });
  });
});
