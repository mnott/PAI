/**
 * route-table.test.ts — the per-class routing table: migration of the retired
 * rank chains, routing that reads element 0 and falls through in order (a
 * local entry that is not running is skipped), the policy modes rewriting the
 * lists, validation and the round trip on a temp config copy (never the live
 * file).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkersSection } from "./config.js";
import { applyRouteOverrides, classRoute, listForPolicy, migrateLegacyChains } from "./route-lists.js";
import { readProfiles, type SessionProfile } from "./session-profile-store.js";
import type { WorkersConfig } from "./config.js";
import { applyPolicyToRoutes, clearSessionRoute, setSessionRoute, routeChoices, routeRows, routeText, setRoute, validateRoute } from "./route-table.js";
import { routeRun, writePolicy, clearPolicy, POLICY_MODES } from "./policy.js";
import { resolveTarget, setCooldown, NoProviderError } from "./routing.js";

const dir = mkdtempSync(join(tmpdir(), "pai-route-"));
const savedYaml = process.env.PAI_WORKERS_YAML;

beforeAll(() => {
  process.env.PAI_WORKERS_YAML = join(dir, "no-workers.yaml");
});
afterAll(() => {
  if (savedYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYaml;
  rmSync(dir, { recursive: true, force: true });
});

const effectiveWorkers = (w: WorkersConfig, p: SessionProfile | undefined): WorkersConfig => ({ ...w, classes: applyRouteOverrides(w.classes, p?.routes) });

const PROVIDERS = {
  glm: { baseUrl: "https://api.example.com/anthropic", keyFile: "~/k", models: { default: "glm-5.3", fast: "glm-5.3-flash" }, env: {} },
  kimi: { baseUrl: "https://api.example.com/kimi", keyFile: "~/k", models: { default: "k3", fast: "kf" }, env: {} },
  "gyro-m": { baseUrl: "http://127.0.0.1:8010", models: { default: "q", fast: "q" }, env: {} },
  iq3s: { baseUrl: "http://127.0.0.1:8012", models: { default: "q3", fast: "q3" }, env: {} },
};
// ping by port: which local servers are loaded
const loaded = (...ports: number[]) => async (url: string) => ports.some((p) => url.endsWith(`:${p}`));

/** A live-shaped config: workers chain gyro-m > anthropic > glm > kimi, orchestrator glm, implement pinned to glm/fast. */
function liveShaped(): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(
    path,
    JSON.stringify({
      workers: {
        enabled: true,
        active: "glm",
        providers: PROVIDERS,
        classes: { implement: "glm/fast", simple: "glm/fast", spotcheck: "glm/fast", plan: "glm", research: "glm" },
        logDir: join(dir, "logs"),
        chains: {
          workers: { local: ["gyro-m"], cloud: ["anthropic", "glm", "kimi"], localFirst: true },
          orchestrator: { local: [], cloud: ["glm"], localFirst: true },
        },
      },
      session: { profile: { chat: { provider: "glm" } } },
    })
  );
  return path;
}

describe("migration from the rank chains", () => {
  it("the workers chain becomes every worker class's list, the orchestrator chain the orchestrate row", () => {
    const { workers } = readWorkersSection(liveShaped());
    // a provider the class already served keeps its alias; plan keeps its own target
    expect(classRoute(workers.classes, "implement")).toEqual(["gyro-m", "anthropic", "glm/fast", "kimi"]);
    expect(classRoute(workers.classes, "spotcheck")).toEqual(["gyro-m", "anthropic", "glm/fast", "kimi"]);
    expect(classRoute(workers.classes, "research")).toEqual(["gyro-m", "anthropic", "glm", "kimi"]);
    expect(classRoute(workers.classes, "plan")).toEqual(["glm"]);
    expect(classRoute(workers.classes, "orchestrate")).toEqual(["glm"]);
  });

  it("a local group that is off migrates away (cloud only), the flat form of the earlier format works", () => {
    const classes = {};
    migrateLegacyChains({ workers: { local: ["gyro-m"], cloud: ["glm"], localFirst: false } }, classes);
    expect(classRoute(classes, "implement")).toEqual(["glm"]);
    const flat = {};
    migrateLegacyChains({ workers: ["gyro-m", "anthropic"], orchestrator: ["anthropic"] }, flat);
    expect(classRoute(flat, "simple")).toEqual(["gyro-m", "anthropic"]);
    expect(migrateLegacyChains(undefined, flat)).toBe(false);
  });

  it("the next write drops the chains key and keeps the lists", () => {
    const path = liveShaped();
    expect(readFileSync(path, "utf8")).toContain("chains");
    setRoute("simple", ["gyro-m", "glm/fast"], path);
    expect(readFileSync(path, "utf8")).not.toContain("chains");
    const { workers } = readWorkersSection(path);
    expect(classRoute(workers.classes, "simple")).toEqual(["gyro-m", "glm/fast"]);
    expect(classRoute(workers.classes, "implement")).toEqual(["gyro-m", "anthropic", "glm/fast", "kimi"]);
    expect(classRoute(workers.classes, "orchestrate")).toEqual(["glm"]);
  });
});

describe("set / validate", () => {
  it("round trips on a temp copy; the orchestrate row moves the session chat provider", () => {
    const path = liveShaped();
    const r = setRoute("orchestrate", ["anthropic/opus", "glm"], path);
    expect(r.text).toBe("orchestrate=anthropic/opus>glm");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.session.profile.chat.provider).toBe("anthropic");
    expect(classRoute(readWorkersSection(path).workers.classes, "orchestrate")).toEqual(["anthropic/opus", "glm"]);
  });

  it("refuses an unknown class, empty or malformed models, unknown providers and models, a model on a local entry", () => {
    const { workers } = readWorkersSection(liveShaped());
    expect(() => validateRoute(workers, "boss", ["glm"])).toThrow(/no class/);
    expect(() => validateRoute(workers, "implement", [])).toThrow(/at least one/);
    expect(() => validateRoute(workers, "implement", "glm")).toThrow(/list/);
    expect(() => validateRoute(workers, "implement", ["nobody"])).toThrow(/no provider/);
    expect(() => validateRoute(workers, "implement", ["glm/gpt9"])).toThrow(/no model/);
    expect(() => validateRoute(workers, "implement", ["gyro-m/q"])).toThrow(/local/);
    expect(validateRoute(workers, "implement", [" glm/glm-5.3-flash ", "glm/glm-5.3-flash", "anthropic/opus", "gyro-m"])).toEqual(["glm/glm-5.3-flash", "anthropic/opus", "gyro-m"]);
  });

  it("the choices list every enabled model of every provider and the local models", () => {
    const { workers } = readWorkersSection(liveShaped());
    const entries = routeChoices(workers).map((c) => c.entry);
    expect(entries).toEqual(expect.arrayContaining(["anthropic/opus", "anthropic/sonnet", "glm/glm-5.3", "glm/glm-5.3-flash", "kimi/k3", "gyro-m", "iq3s"]));
    expect(routeChoices(workers).find((c) => c.entry === "gyro-m")).toMatchObject({ label: "local gyro-m", local: true });
  });
});

describe("routing reads the lists", () => {
  it("element 0 serves; a local entry that is not running is skipped, in order", async () => {
    const path = liveShaped();
    setRoute("implement", ["iq3s", "gyro-m", "anthropic", "glm/fast"], path);
    const { workers } = readWorkersSection(path);
    const logDir = join(dir, "logs-a");
    // both up: element 0
    expect((await routeRun(workers, logDir, { className: "implement" }, { ping: loaded(8012, 8010) }))!.providerFlag).toBe("iq3s");
    // element 0 not running: the next local
    const second = (await routeRun(workers, logDir, { className: "implement" }, { ping: loaded(8010) }))!;
    expect(second.providerFlag).toBe("gyro-m");
    expect(second.route.local).toBe(true);
    // no local running: cloud (no pin), the cloud entries are walked by resolveTarget
    expect((await routeRun(workers, logDir, { className: "implement" }, { ping: loaded() }))!.providerFlag).toBeNull();
    const t = resolveTarget(workers, logDir, { className: "implement", sessionEnv: {} });
    expect(t.providerName).toBe("anthropic");
    // --cloud / --urgent skip the local entries even when they run
    expect((await routeRun(workers, logDir, { className: "implement", cloud: true }, { ping: loaded(8010) }))!.providerFlag).toBeNull();
    expect((await routeRun(workers, logDir, { className: "implement", urgent: true }, { ping: loaded(8010) }))!.providerFlag).toBeNull();
  });

  it("the cloud entries fall through in order past a cooldown, with the model of the entry", () => {
    const path = liveShaped();
    setRoute("review", ["anthropic/opus", "glm/glm-5.3-flash", "kimi"], path);
    const { workers } = readWorkersSection(path);
    const logDir = join(dir, "logs-b");
    const first = resolveTarget(workers, logDir, { className: "review", sessionEnv: {} });
    expect(first).toMatchObject({ providerName: "anthropic", modelId: "opus" });
    setCooldown(logDir, "anthropic", 10);
    const second = resolveTarget(workers, logDir, { className: "review", sessionEnv: {} });
    expect(second).toMatchObject({ providerName: "glm", modelAlias: "fast" });
    setCooldown(logDir, "glm", 10);
    setCooldown(logDir, "kimi", 10);
    expect(() => resolveTarget(workers, logDir, { className: "review", sessionEnv: {} })).toThrow(NoProviderError);
  });

  it("a cloud-first list uses a local entry only when the cloud is unavailable", async () => {
    const path = liveShaped();
    setRoute("implement", ["anthropic", "gyro-m"], path);
    const { workers } = readWorkersSection(path);
    const logDir = join(dir, "logs-c");
    expect((await routeRun(workers, logDir, { className: "implement" }, { ping: loaded(8010) }))!.providerFlag).toBeNull();
    setCooldown(logDir, "anthropic", 10);
    expect((await routeRun(workers, logDir, { className: "implement" }, { ping: loaded(8010) }))!.providerFlag).toBe("gyro-m");
    // --local-ok asks for the local entry first
    const fresh = join(dir, "logs-c2");
    expect((await routeRun(workers, fresh, { className: "implement", localOk: true }, { ping: loaded(8010) }))!.providerFlag).toBe("gyro-m");
  });

  it("a list of local entries only fails when none runs", async () => {
    const path = liveShaped();
    setRoute("simple", ["iq3s", "gyro-m"], path);
    const { workers } = readWorkersSection(path);
    await expect(routeRun(workers, join(dir, "logs-d"), { className: "simple" }, { ping: loaded() })).rejects.toThrow(/start a local server/);
  });
});

describe("policy modes rewrite the lists", () => {
  const isLocal = (n: string) => n === "gyro-m" || n === "iq3s";
  it("listForPolicy", () => {
    const l = ["anthropic", "iq3s", "glm/fast"];
    expect(listForPolicy("prefer-local", l, isLocal, "gyro-m")).toEqual(["gyro-m", "iq3s", "anthropic", "glm/fast"]);
    expect(listForPolicy("prefer-local", ["anthropic", "iq3s", "gyro-m"], isLocal, "gyro-m")).toEqual(["gyro-m", "iq3s", "anthropic"]);
    expect(listForPolicy("auto", l, isLocal, null)).toEqual(["iq3s", "anthropic", "glm/fast"]);
    expect(listForPolicy("prefer-cloud", ["gyro-m", "anthropic"], isLocal, "gyro-m")).toEqual(["anthropic", "gyro-m"]);
    expect(listForPolicy("cloud-only", ["gyro-m", "anthropic"], isLocal, "gyro-m")).toEqual(["anthropic"]);
    expect(listForPolicy("local-only", ["anthropic", "gyro-m"], isLocal, "gyro-m")).toEqual(["gyro-m"]);
  });

  it("`pai worker policy <mode>` rewrites implement / simple / spotcheck and leaves the other rows", () => {
    expect(POLICY_MODES).toContain("prefer-local");
    const path = liveShaped();
    setRoute("implement", ["anthropic", "glm/fast"], path);
    applyPolicyToRoutes("prefer-local", path);
    let c = readWorkersSection(path).workers.classes;
    expect(classRoute(c, "implement")).toEqual(["gyro-m", "anthropic", "glm/fast"]);
    expect(classRoute(c, "research")).toEqual(["gyro-m", "anthropic", "glm", "kimi"]);
    applyPolicyToRoutes("cloud-only", path);
    c = readWorkersSection(path).workers.classes;
    expect(classRoute(c, "implement")).toEqual(["anthropic", "glm/fast"]);
    expect(classRoute(c, "spotcheck")).toEqual(["anthropic", "glm/fast", "kimi"]);
    expect(classRoute(c, "research")).toEqual(["gyro-m", "anthropic", "glm", "kimi"]);
    applyPolicyToRoutes("prefer-cloud", path);
    expect(classRoute(readWorkersSection(path).workers.classes, "simple")).toEqual(["anthropic", "glm/fast", "kimi", "gyro-m"]);
    applyPolicyToRoutes("local-only", path);
    expect(classRoute(readWorkersSection(path).workers.classes, "simple")).toEqual(["gyro-m"]);
  });

  it("a policy file with no class list still routes as before", async () => {
    const { workers } = readWorkersSection(liveShaped());
    const bare = { ...workers, classes: {} };
    const logDir = join(dir, "logs-e");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logDir, { recursive: true });
    writePolicy(logDir, "prefer-local");
    expect((await routeRun(bare, logDir, {}, { ping: loaded(8010) }))!.providerFlag).toBe("gyro-m");
    clearPolicy(logDir);
    expect(await routeRun(bare, logDir, {}, { ping: loaded(8010) })).toBeNull();
  });
});

describe("rows and text", () => {
  it("chips carry the state: available, tight (window above 80%), idle (not running), unavailable", async () => {
    const path = liveShaped();
    setRoute("implement", ["gyro-m", "iq3s", "anthropic/sonnet", "glm/fast", "kimi"], path);
    const { workers } = readWorkersSection(path);
    const logDir = join(dir, "logs-f");
    setCooldown(logDir, "kimi", 10);
    const now = Date.now();
    const rows = await routeRows(workers, {
      logDir,
      running: async (n) => n === "gyro-m",
      budgets: {
        anthropic: { percent: 10, resetAt: null, fetchedAt: now },
        glm: { percent: 85, resetAt: null, fetchedAt: now, windows: [{ name: "5h", percent: 85 }] },
      },
    });
    const impl = rows.find((r) => r.cls === "implement")!;
    expect(impl.label).toBe("Implement");
    expect(impl.chips.map((c) => [c.label, c.state])).toEqual([
      ["local gyro-m", "available"],
      ["local iq3s", "idle"],
      ["anthropic/sonnet", "available"],
      ["glm/glm-5.3-flash", "tight"],
      ["kimi/k3", "unavailable"],
    ]);
    expect(rows[0]!.cls).toBe("orchestrate");
    expect(routeText(rows)).toContain("local gyro-m → local iq3s (not running) → anthropic/sonnet → glm/glm-5.3-flash (budget 85%)");
  });

  it("the old chains module is gone", () => {
    expect(existsSync(join(__dirname, "chains.ts"))).toBe(false);
  });
});

describe("per-session overrides", () => {
  const profiles = () => join(dir, `profiles-${Math.random().toString(36).slice(2)}.yaml`);

  it("the session's row wins for that session only; clear restores the global row", async () => {
    const path = liveShaped();
    const pp = profiles();
    setRoute("implement", ["glm/fast"], path, "context width, reasoning");
    setSessionRoute("job-search", "implement", ["anthropic/sonnet", "kimi"], { path, profilesPath: pp, note: "needs the wide context" });
    const { workers } = readWorkersSection(path);
    const logDir = join(dir, "logs-s");
    const mine = effectiveWorkers(workers, readProfiles(pp)["job-search"]);
    const other = effectiveWorkers(workers, readProfiles(pp)["other"]);
    expect(classRoute(mine.classes, "implement")).toEqual(["anthropic/sonnet", "kimi"]);
    expect(classRoute(other.classes, "implement")).toEqual(["glm/fast"]);
    expect(classRoute(workers.classes, "implement")).toEqual(["glm/fast"]);
    const pick = async (w: typeof workers) => routeRun(w, logDir, { className: "implement" }, { ping: loaded(8010) });
    expect(await pick(other)).toBeNull();
    expect(resolveTarget(mine, logDir, { className: "implement" }).providerName).toBe("anthropic");
    expect(resolveTarget(other, logDir, { className: "implement" }).providerName).toBe("glm");
    setSessionRoute("local-sess", "implement", ["gyro-m"], { path, profilesPath: pp });
    const loc = effectiveWorkers(workers, readProfiles(pp)["local-sess"]);
    expect((await pick(loc))?.providerFlag).toBe("gyro-m");
    expect(await pick(other)).toBeNull();
    expect(clearSessionRoute("job-search", "implement", pp)).toMatch(/cleared/);
    expect(readProfiles(pp)["job-search"]?.routes).toBeUndefined();
    expect(classRoute(effectiveWorkers(workers, readProfiles(pp)["job-search"]).classes, "implement")).toEqual(["glm/fast"]);
  });

  it("the effective table marks overridden rows; the global view lists the sessions and notes", async () => {
    const path = liveShaped();
    const pp = profiles();
    setRoute("implement", ["glm/fast"], path, "context width, reasoning");
    setSessionRoute("job-search", "implement", ["anthropic/sonnet"], { path, profilesPath: pp, note: "wide" });
    const { workers } = readWorkersSection(path);
    const deps = { logDir: join(dir, "logs-t"), running: async () => true };
    const eff = routeText(await routeRows(workers, { ...deps, session: readProfiles(pp)["job-search"] }));
    expect(eff).toMatch(/implement\s+anthropic\/sonnet  \[session override\]  # wide/);
    expect(eff).toMatch(/simple\s+local gyro-m/);
    const rows = await routeRows(workers, { ...deps, profiles: readProfiles(pp) });
    const impl = rows.find((r) => r.cls === "implement")!;
    expect(impl.note).toBe("context width, reasoning");
    expect(impl.sessions).toMatchObject([{ session: "job-search", note: "wide", chips: [{ entry: "anthropic/sonnet" }] }]);
    expect(routeText(rows)).toContain("    job-search: anthropic/sonnet  # wide");
    expect(readWorkersSection(path).workers.classes.implement).toMatchObject({ models: ["glm/fast"], note: "context width, reasoning" });
  });

  it("refuses an unknown class or model for a session override", () => {
    const path = liveShaped();
    expect(() => setSessionRoute("s", "boss", ["glm"], { path, profilesPath: profiles() })).toThrow(/no class/);
    expect(() => setSessionRoute("s", "implement", ["nobody/x"], { path, profilesPath: profiles() })).toThrow(/no provider/);
  });
});
