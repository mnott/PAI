import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armConfigGuard, confirmConfigGuard, guardedEdit, guardStatusText, parseWindow, readGuardState,
  tickConfigGuard, type ProofDeps,
} from "./config-guard.js";
import { parseDocument } from "yaml";
import { parseWorkersYamlDocument, providerEntryProblem, providerWarnings, effectiveWorkersYamlData } from "../workers/workers-config.js";
import { routeRows } from "../workers/route-table.js";
import { guardedRegistryWrite, handleRegistryRoute, readRegistry, saveRegistry, type RegistryCtx } from "../router/cockpit-registry.js";

let dir: string;
const saved: Record<string, string | undefined> = {};
const GOOD = "# good\nworkers:\n  pool:\n    maxSlots: 2\n";
const BAD = "# bad\nworkers:\n  pool: [unterminated\n";
const POISON = "# loads as YAML, breaks the loader\nworkers:\n  poison: true\n";

/** Healthy services; the loader rejects a config.yaml/workers.yaml that holds `poison`. */
function deps(extra: Partial<ProofDeps> = {}): ProofDeps {
  return {
    load: () => {
      for (const f of [join(dir, "config.yaml"), process.env.PAI_WORKERS_YAML!]) {
        if (existsSync(f) && readFileSync(f, "utf8").includes("poison")) throw new Error("poison key rejected");
      }
    },
    daemonHealth: async () => true,
    routerHealth: async () => true,
    routerGet: async () => 200,
    unreachableRuntimes: async () => [],
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-guard-"));
  for (const k of ["PAI_HOME", "PAI_CONFIG_FILE", "PAI_WORKERS_YAML"]) saved[k] = process.env[k];
  process.env.PAI_HOME = dir;
  process.env.PAI_CONFIG_FILE = join(dir, "config.json");
  process.env.PAI_WORKERS_YAML = join(dir, "workers.yaml");
  writeFileSync(join(dir, "config.yaml"), GOOD);
  writeFileSync(join(dir, "workers.yaml"), "providers: {}\n");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const cfg = () => join(dir, "config.yaml");
const T0 = 1_700_000_000_000;

describe("config guard", () => {
  it("snapshot is byte-identical and restore brings it back (deadline passed)", async () => {
    const bytes = Buffer.from(GOOD + "äö trailing-space \n");
    writeFileSync(cfg(), bytes);
    const [e] = armConfigGuard({ files: ["config.yaml"], forMs: 60_000, now: T0 });
    expect(readFileSync(e.snapshot!).equals(bytes)).toBe(true);
    writeFileSync(cfg(), BAD);
    const calls: string[] = [];
    const tick = (now: number) => tickConfigGuard({ now: () => now, reload: (f) => void calls.push(`reload:${f}`), notify: () => void calls.push("notify"), log: () => undefined });
    expect(await tick(T0 + 59_000)).toEqual([]); // not due: still bad, untouched
    expect(readFileSync(cfg(), "utf8")).toBe(BAD);
    expect(await tick(T0 + 61_000)).toEqual(["config.yaml"]);
    expect(readFileSync(cfg()).equals(bytes)).toBe(true);
    expect(calls).toEqual(["reload:config.yaml", "notify"]);
    expect(readGuardState()).toEqual([]);
    expect(guardStatusText().text).toBe("reverted: deadline passed without confirm");
    expect(await tick(T0 + 120_000)).toEqual([]); // one notice only
    expect(calls.length).toBe(2);
  });

  it("good edit + confirm keeps the change and clears the deadline", async () => {
    armConfigGuard({ files: ["config.yaml"], now: T0 });
    expect(guardStatusText().state).toBe("pending");
    writeFileSync(cfg(), GOOD + "extra: 1\n");
    const r = await confirmConfigGuard(deps());
    expect(r.ok).toBe(true);
    expect(readFileSync(cfg(), "utf8")).toBe(GOOD + "extra: 1\n");
    expect(readGuardState()).toEqual([]);
    expect(guardStatusText().text).toBe("change kept: proven");
    // the deadline no longer fires
    expect(await tickConfigGuard({ now: () => T0 + 10 * 3_600_000, reload: () => undefined, notify: () => undefined, log: () => undefined })).toEqual([]);
    expect(readFileSync(cfg(), "utf8")).toBe(GOOD + "extra: 1\n");
  });

  it("bad edit + confirm reverts immediately (yaml broken, loader rejects, service down)", async () => {
    const cases: [string, ProofDeps, string][] = [
      [BAD, deps(), "yaml:config.yaml"],
      [POISON, deps(), "loader"],
      [GOOD + "x: 1\n", deps({ routerGet: async (p) => (p === "/cockpit" ? 0 : 200) }), "router:/cockpit"],
      [GOOD + "x: 2\n", deps({ unreachableRuntimes: async () => ["gyro-l"] }), "runtimes"],
    ];
    for (const [bad, d, name] of cases) {
      writeFileSync(cfg(), GOOD);
      armConfigGuard({ files: ["config.yaml"] });
      writeFileSync(cfg(), bad);
      let reloaded = false;
      const r = await confirmConfigGuard(d, () => void (reloaded = true));
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => !c.ok)?.name).toBe(name);
      expect(readFileSync(cfg(), "utf8")).toBe(GOOD);
      expect(reloaded).toBe(true);
      expect(guardStatusText().text).toContain("reverted:");
    }
  });

  it("guardedEdit (config set path): keeps a good edit, reverts a poisoned one, ignores services already down", async () => {
    const ok = await guardedEdit(() => writeFileSync(cfg(), GOOD + "a: 1\n"), deps());
    expect(ok.reverted).toBe(false);
    expect(readFileSync(cfg(), "utf8")).toBe(GOOD + "a: 1\n");
    const bad = await guardedEdit(() => writeFileSync(cfg(), POISON), deps());
    expect(bad.reverted).toBe(true);
    expect(readFileSync(cfg(), "utf8")).toBe(GOOD + "a: 1\n");
    const daemonDown = await guardedEdit(() => writeFileSync(cfg(), GOOD + "b: 1\n"), deps({ daemonHealth: async () => false }));
    expect(daemonDown.reverted).toBe(false);
    await expect(guardedEdit(() => { throw new Error("refused"); }, deps())).rejects.toThrow("refused");
    expect(readGuardState()).toEqual([]);
  });

  it("an already armed file keeps its first snapshot", () => {
    const [a] = armConfigGuard({ files: ["config.yaml"], now: T0 });
    writeFileSync(cfg(), BAD);
    const [b] = armConfigGuard({ files: ["config.yaml"], now: T0 + 1000, forMs: 5 * 60_000 });
    expect(b.snapshot).toBe(a.snapshot);
    expect(readFileSync(b.snapshot!, "utf8")).toBe(GOOD);
  });

  it("parses windows", () => {
    expect(parseWindow("10m")).toBe(600_000);
    expect(parseWindow("90s")).toBe(90_000);
    expect(parseWindow("2h")).toBe(7_200_000);
    expect(() => parseWindow("soon")).toThrow();
  });
});

describe("cockpit registry save under the guard", () => {
  const loadsPoison = (): ProofDeps => deps({
    load: () => { if (readFileSync(process.env.PAI_WORKERS_YAML!, "utf8").includes("poison")) throw new Error("poison key rejected"); },
  });
  const registryCtx = (): RegistryCtx => ({
    yamlPath: process.env.PAI_WORKERS_YAML!,
    backupDir: join(dir, "workers-backups"),
    guard: { deps: loadsPoison() },
  });

  it("a save the loader rejects is reverted and says so", async () => {
    const ctx = registryCtx();
    const before = readFileSync(ctx.yamlPath, "utf8");
    const hash = readRegistry(ctx).hash;
    const r = await guardedRegistryWrite(ctx, () => saveRegistry("providers: {}\n# poison\n", hash, ctx));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("reverted: loader (poison key rejected)");
    expect(readFileSync(ctx.yamlPath, "utf8")).toBe(before);
    expect(guardStatusText().text).toContain("reverted: loader");
    expect(readGuardState()).toEqual([]);
  });

  it("a good save is kept, proven", async () => {
    const ctx = registryCtx();
    const r = await guardedRegistryWrite(ctx, () => saveRegistry("providers: {}\n# edited\n", readRegistry(ctx).hash, ctx));
    expect(r.ok).toBe(true);
    expect((r as { guard?: string }).guard).toBe("change kept: proven");
    expect(readFileSync(ctx.yamlPath, "utf8")).toContain("# edited");
  });

  it("the HTTP route reverts a breaking save and reports it", async () => {
    const ctx = registryCtx();
    const before = readFileSync(ctx.yamlPath, "utf8");
    const body = JSON.stringify({ yaml: "providers: {}\n# poison\n", baseHash: readRegistry(ctx).hash });
    let status = 0;
    let out = "";
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const res = { writeHead: (s: number) => void (status = s), end: (s: string) => { out = s; finish(); } } as never;
    const handled = handleRegistryRoute({ method: "POST" } as never, res, "/cockpit/registry/save", () => ctx, { sameOrigin: () => true, readBody: async () => body });
    expect(handled).toBe(true);
    await done;
    const j = JSON.parse(out) as { ok: boolean; error: string; reverted: boolean };
    expect(status).toBe(200);
    expect(j.ok).toBe(false);
    expect(j.reverted).toBe(true);
    expect(j.error).toMatch(/^reverted: /);
    expect(readFileSync(ctx.yamlPath, "utf8")).toBe(before);
  });
});

// --- provider entry validation (#30) ---
const GOOD_SIGNAL = `  signal-2:
    url: [http://127.0.0.1:8101, http://127.0.0.1:8102]
    models: {default: m1}
`;
const BAD_SIGNAL = `  signal-2:
    baseUrl: [http://127.0.0.1:8101, http://127.0.0.1:8102]
    models: {default: m1}
`;
const PV_REST = `  glm:
    url: http://127.0.0.1:9000
    models: {default: g1}
tiers:
  - id: t2
    name: Worker
    default: true
    models: [signal-2, glm]
`;
const pvYaml = (sig: string) => `providers:\n${sig}${PV_REST}`;
const pvParse = (t: string) => parseWorkersYamlDocument(parseDocument(t), join(dir, "workers.yaml"));

describe("provider entry validation", () => {
  it("baseUrl list is invalid with a message naming key and shape", () => {
    const d = pvParse(pvYaml(BAD_SIGNAL));
    expect(d.providers["signal-2"]).toBeUndefined();
    expect(d.invalidProviders?.["signal-2"]).toMatch(/unknown key "baseUrl".*did you mean "url"/);
    expect(d.providers.glm).toBeDefined();
  });
  it("good multi-url entry is valid", () => {
    const d = pvParse(pvYaml(GOOD_SIGNAL));
    expect(d.invalidProviders).toBeUndefined();
    expect(d.providers["signal-2"].instances?.length).toBe(2);
  });
  it("wrong types and missing url", () => {
    expect(providerEntryProblem({ url: { a: 1 } })).toMatch(/url must be a string, or a list/);
    expect(providerEntryProblem({ url: "http://x", enabled: "yes" })).toMatch(/enabled must be true or false/);
    expect(providerEntryProblem({ url: "http://x", models: ["a"] })).toMatch(/models must be a mapping \(got a list\)/);
    expect(providerEntryProblem({ models: { default: "a" } })).toMatch(/url is required/);
    expect(providerEntryProblem("x")).toMatch(/must be a mapping/);
  });
  it("route falls back past the invalid provider and the warning is recorded", async () => {
    providerWarnings.length = 0;
    writeFileSync(join(dir, "workers.yaml"), pvYaml(BAD_SIGNAL));
    const data = effectiveWorkersYamlData(join(dir, "workers.yaml"));
    expect(providerWarnings).toHaveLength(1);
    expect(providerWarnings[0]).toMatch(/provider signal-2 invalid: unknown key "baseUrl".*t2: falling back to glm/);
    const workers = { providers: data.providers, invalidProviders: data.invalidProviders, tiers: data.tiers, routing: {} } as never;
    const rows = await routeRows(workers, { logDir: dir, running: async () => true } as never);
    expect(rows[0].chips[0].state).toBe("unavailable");
    expect(rows[0].chips[0].why).toMatch(/^invalid: unknown key "baseUrl"/);
    expect(rows[0].chips[1].provider).toBe("glm");
  });
  it("config-guard proof fails and reverts on an invalid provider entry; passes on a good one", async () => {
    const wy = join(dir, "workers.yaml");
    writeFileSync(wy, pvYaml(GOOD_SIGNAL));
    armConfigGuard({ files: ["workers.yaml"], forMs: 60_000 });
    writeFileSync(wy, pvYaml(BAD_SIGNAL));
    const r = await confirmConfigGuard(deps(), undefined, { files: ["workers.yaml"] });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "providers")?.detail).toMatch(/provider signal-2 invalid: unknown key "baseUrl"/);
    expect(r.reverted).toEqual(["workers.yaml"]);
    armConfigGuard({ files: ["workers.yaml"], forMs: 60_000 });
    const ok = await confirmConfigGuard(deps(), undefined, { files: ["workers.yaml"] });
    expect(ok.checks.find((c) => c.name === "providers")?.ok).toBe(true);
    expect(ok.ok).toBe(true);
  });
});
