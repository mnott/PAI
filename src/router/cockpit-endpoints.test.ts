/**
 * cockpit-endpoints.test.ts — the cockpit's selector edit and endpoint view:
 * route.set / endpoint.enable actions against a temp config, and the pure
 * endpoint/selector builders. No server is started or probed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkersSection } from "../workers/config.js";
import type { LocalInstance } from "../workers/local-instances.js";

const dir = mkdtempSync(join(tmpdir(), "pai-cockpit-ep-"));
const savedYaml = process.env.PAI_WORKERS_YAML;
let runCockpitAction: typeof import("./cockpit-actions.js")["runCockpitAction"];
let endpointRows: typeof import("./cockpit-endpoints.js")["endpointRows"];
let selectorChoices: typeof import("./cockpit-endpoints.js")["selectorChoices"];

beforeAll(async () => {
  process.env.PAI_WORKERS_YAML = join(dir, "no-workers.yaml");
  ({ runCockpitAction } = await import("./cockpit-actions.js"));
  ({ endpointRows, selectorChoices } = await import("./cockpit-endpoints.js"));
});
afterAll(() => {
  if (savedYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYaml;
  rmSync(dir, { recursive: true, force: true });
});

const PROVIDERS = {
  glm: { baseUrl: "https://api.example.com/anthropic", keyFile: "~/k", models: { default: "glm-5.3", fast: "glm-5.3-flash" }, env: {} },
  "gyro-m": { baseUrl: "http://127.0.0.1:8010", models: { default: "q", fast: "q" }, env: {} },
  mac2: { baseUrl: "http://10.0.0.2:8000", models: { default: "qwen", fast: "qwen" }, env: {}, characteristics: { tags: ["fast"], classes: ["implement"] } },
};
const TIERS = [
  { id: "t0", name: "Session", models: ["anthropic/opus"], session: true },
  { id: "t2", name: "Worker", models: ["gyro-m", "glm/fast"], classes: ["implement"], default: true },
];

function fixture() {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, JSON.stringify({ workers: { enabled: true, active: "glm", providers: PROVIDERS, tiers: TIERS, logDir: join(dir, "logs") }, session: { profile: { chat: { provider: "glm" } } } }));
  const deps = () => ({ configPath: path, workers: readWorkersSection(path).workers, ledger: join(dir, "ledger.log"), home: dir, workersYaml: join(dir, "workers.yaml") }) as never;
  return { path, deps };
}

const managed: LocalInstance = { id: "gyro-m#1", model: "gyro-m", provider: "gyro-m", url: "http://127.0.0.1:8010", origin: "managed", port: 8010, pid: 1, state: "ready", startedAt: 1, log: "" };

describe("cockpit routing selectors", () => {
  it("route.set writes a selector first through the route-table writer; a bad selector is refused and nothing changes", async () => {
    const { path, deps } = fixture();
    const r = await runCockpitAction({ action: "route.set", target: "t2", value: "model:qwen,gyro-m,glm/fast" }, deps());
    expect(r.ok).toBe(true);
    expect(readWorkersSection(path).workers.tiers.find((t) => t.id === "t2")!.models).toEqual(["model:qwen", "gyro-m", "glm/fast"]);
    const bad = await runCockpitAction({ action: "route.set", target: "t2", value: "tag:" }, deps());
    expect(bad.ok).toBe(false);
    const unknown = await runCockpitAction({ action: "route.set", target: "t2", value: "nobody" }, deps());
    expect(unknown.ok).toBe(false);
    expect(readWorkersSection(path).workers.tiers.find((t) => t.id === "t2")!.models).toEqual(["model:qwen", "gyro-m", "glm/fast"]);
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toContain("route.set");
  });

  it("endpoint.enable switches routing of a registered endpoint; managed and cloud providers are refused", async () => {
    const { path, deps } = fixture();
    const off = await runCockpitAction({ action: "endpoint.enable", target: "mac2", value: "off" }, deps());
    expect(off.ok).toBe(true);
    expect(readWorkersSection(path).workers.providers.mac2!.enabled).toBe(false);
    const on = await runCockpitAction({ action: "endpoint.enable", target: "mac2", value: "on" }, deps());
    expect(on.ok).toBe(true);
    expect(readWorkersSection(path).workers.providers.mac2!.enabled).toBe(true);
    expect((await runCockpitAction({ action: "endpoint.enable", target: "gyro-m", value: "off" }, deps())).ok).toBe(false);
    expect((await runCockpitAction({ action: "endpoint.enable", target: "mac2", value: "maybe" }, deps())).ok).toBe(false);
  });

  it("the endpoint view lists managed and registered endpoints with origin, host and health; selectors come from the enabled ones", () => {
    const { path } = fixture();
    const workers = readWorkersSection(path).workers;
    const rows = endpointRows(workers, [managed], (i) => i.id !== "mac2");
    expect(rows.map((r) => [r.id, r.origin, r.host, r.healthy, r.enabled])).toEqual([
      ["gyro-m#1", "managed", "127.0.0.1:8010", true, true],
      ["mac2", "registered", "10.0.0.2:8000", false, true],
    ]);
    const entries = selectorChoices(workers, rows).map((c) => c.entry);
    expect(entries).toEqual(expect.arrayContaining(["local", "model:gyro-m", "model:mac2", "tag:fast", "class:implement", "gyro-m", "glm/glm-5.3"]));
    const disabled = endpointRows({ ...workers, providers: { ...workers.providers, mac2: { ...workers.providers.mac2!, enabled: false } } }, [], () => true);
    expect(disabled[0]).toMatchObject({ id: "mac2", enabled: false, healthy: false });
    expect(selectorChoices(workers, disabled).map((c) => c.entry)).not.toContain("tag:fast");
  });
});

describe("endpointRows with an unparsable baseUrl", () => {
  it("falls back to the raw value without throwing a URL error", () => {
    const workers = { providers: { muse: { baseUrl: "", characteristics: { tags: [] } } } } as unknown as Parameters<typeof endpointRows>[0];
    const real = globalThis.URL;
    let thrown = 0;
    globalThis.URL = new Proxy(real, { construct(t, a: [string, string?]) { try { return new t(...a); } catch (e) { thrown++; throw e; } } });
    try {
      expect(endpointRows(workers, [], () => true)[0]!.host).toBe("");
    } finally {
      globalThis.URL = real;
    }
    expect(thrown).toBe(0);
  });
});
