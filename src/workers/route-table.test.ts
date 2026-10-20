/**
 * route-table.test.ts — the tier routing table (t0 Session / t1 Orchestrator / t2 Worker, all from config): migrations of
 * the retired rank chains and the three-role table, routing that reads element 0 and falls through in order (a
 * local entry that is not running is skipped), the policy modes rewriting the
 * lists, validation and the round trip on a temp config copy (never the live
 * file).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkersSection } from "./config.js";
import {
  applyRouteOverrides,
  classRoute,
  findTier,
  listForPolicy,
  migrateClassRoutes,
  migrateLegacyChains,
  migrateToTiers,
  migrateSessionRoutes,
  parseTiersValue,
  type TierDef,
} from "./route-lists.js";
import { readProfiles, type SessionProfile } from "./session-profile-store.js";
import type { WorkersConfig } from "./config.js";
import { applyPolicyToRoutes, clearSessionRoute, flowText, setSessionRoute, routeChoices, routeRows, routeText, sessionStartTarget, setRoute, validateRoute } from "./route-table.js";
import { routeRun, writePolicy, clearPolicy, POLICY_MODES } from "./policy.js";
import { resolveTarget, setCooldown, NoProviderError } from "./routing.js";
import { routeClassOf } from "./run.js";

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

const effectiveWorkers = (w: WorkersConfig, p: SessionProfile | undefined): WorkersConfig => ({ ...w, tiers: applyRouteOverrides(w.tiers, p?.routes) });

const PROVIDERS = {
  glm: { baseUrl: "https://api.example.com/anthropic", keyFile: "~/k", models: { default: "glm-5.3", fast: "glm-5.3-flash" }, env: {} },
  kimi: { baseUrl: "https://api.example.com/kimi", keyFile: "~/k", models: { default: "k3", fast: "kf" }, env: {} },
  "gyro-m": { baseUrl: "http://127.0.0.1:8010", models: { default: "q", fast: "q" }, env: {} },
  iq3s: { baseUrl: "http://127.0.0.1:8012", models: { default: "q3", fast: "q3" }, env: {} },
};
// ping by port: which local servers are loaded
const loaded = (...ports: number[]) => async (url: string) => ports.some((p) => url.endsWith(`:${p}`));

/** The tiers a fixture config carries (a test fixture, not a default: the code reads them from the config). */
const TIERS: TierDef[] = [
  { id: "t0", name: "Session", description: "the interactive session", models: ["anthropic/opus", "glm/glm-5.3"], session: true, note: "context width, reasoning" },
  { id: "t1", name: "Orchestrator", models: ["anthropic/sonnet", "glm/glm-5.3-flash", "gyro-m"], classes: ["orchestrate", "plan"], note: "planning, reasoning" },
  { id: "t2", name: "Worker", models: ["gyro-m", "anthropic", "glm/fast", "kimi"], classes: ["implement", "research", "draft", "review", "complex", "simple", "spotcheck"], default: true },
];

/** A fixture config with the tiers above. */
function liveShaped(tiers: TierDef[] = TIERS): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, JSON.stringify({ workers: { enabled: true, active: "glm", providers: PROVIDERS, tiers, logDir: join(dir, "logs") }, session: { profile: { chat: { provider: "glm" } } } }));
  return path;
}

/** A config shaped like the retired rank chains. */
function chainShaped(): string {
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
  it("the workers chain becomes the Worker tier's list, the orchestrator chain the Orchestrator's tail", () => {
    const { workers } = readWorkersSection(chainShaped());
    // a provider the class already served keeps its alias
    expect(classRoute(workers.tiers, "implement")).toEqual(["gyro-m", "anthropic", "glm/fast", "kimi"]);
    expect(classRoute(workers.tiers, "spotcheck")).toEqual(["gyro-m", "anthropic", "glm/fast", "kimi"]);
    expect(classRoute(workers.tiers, "research")).toEqual(["gyro-m", "anthropic", "glm/fast", "kimi"]);
    expect(classRoute(workers.tiers, "plan")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash", "glm"]);
    expect(classRoute(workers.tiers, "orchestrate")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash", "glm"]);
  });

  it("a local group that is off migrates away (cloud only), the flat form of the earlier format works", () => {
    const classes = {};
    migrateLegacyChains({ workers: { local: ["gyro-m"], cloud: ["glm"], localFirst: false } }, classes);
    const cfg = { classes, tiers: [] as TierDef[] };
    migrateToTiers(cfg);
    expect(classRoute(cfg.tiers, "implement")).toEqual(["glm"]);
    const flat = {};
    migrateLegacyChains({ workers: ["gyro-m", "anthropic"], orchestrator: ["anthropic"] }, flat);
    const cfg2 = { classes: flat, tiers: [] as TierDef[] };
    migrateToTiers(cfg2);
    expect(classRoute(cfg2.tiers, "simple")).toEqual(["gyro-m", "anthropic"]);
    expect(migrateLegacyChains(undefined, flat)).toBe(false);
  });

  it("the next write drops the chains key and keeps the tiers", () => {
    const path = chainShaped();
    expect(readFileSync(path, "utf8")).toContain("chains");
    setRoute("simple", ["gyro-m", "glm/fast"], path);
    expect(readFileSync(path, "utf8")).not.toContain("chains");
    const { workers } = readWorkersSection(path);
    expect(classRoute(workers.tiers, "simple")).toEqual(["gyro-m", "glm/fast"]);
    expect(classRoute(workers.tiers, "implement")).toEqual(["gyro-m", "glm/fast"]);
    expect(workers.tiers.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
  });
});

/** The live-shaped three-role table (workers.classes keys orchestrator / worker / quick). */
const THREE_ROLES = () => ({
  orchestrator: { provider: "anthropic", models: ["anthropic/sonnet", "glm/glm-5.3-flash", "gyro-m"] },
  worker: { provider: "gyro-m", models: ["gyro-m", "anthropic", "glm/fast", "kimi"] },
  quick: { provider: "gyro-m", models: ["gyro-m", "anthropic", "glm/fast", "kimi"] },
});

describe("tiers", () => {
  it("every class maps to its configured tier; unknown classes take the default tier; a tier id names itself", () => {
    expect(Object.fromEntries(["orchestrate", "plan", "implement", "research", "draft", "review", "complex", "simple", "spotcheck", "brand-new", "toString"].map((c) => [c, findTier(TIERS, c)?.id]))).toEqual({
      orchestrate: "t1", plan: "t1",
      implement: "t2", research: "t2", draft: "t2", review: "t2", complex: "t2", simple: "t2", spotcheck: "t2",
      "brand-new": "t2", toString: "t2",
    });
    expect(findTier(TIERS, "t0")?.id).toBe("t0");
    // no default tier: an unlisted class has no tier
    expect(findTier(TIERS.filter((t) => !t.default), "brand-new")).toBeUndefined();
  });

  it("the tier set is config: a 4-tier list parses, with its names, flags and escalation, and refuses malformed ones", () => {
    const four = parseTiersValue([
      { id: "a", name: "Alpha", models: ["x"], session: true },
      { id: "b", models: ["y", "z"], classes: ["c1"], escalation: { after: 2 } },
      { id: "c", models: ["y"], classes: ["c2"] },
      { id: "d", models: ["y"], default: true, description: "rest" },
    ]);
    expect(four.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    expect(four[1]).toMatchObject({ name: "b", escalation: { after: 2 } });
    expect(findTier(four, "c1")?.id).toBe("b");
    expect(findTier(four, "other")?.id).toBe("d");
    expect(() => parseTiersValue([{ id: "a", models: [] }])).toThrow(/at least one model/);
    expect(() => parseTiersValue([{ id: "a", models: ["x"] }, { id: "a", models: ["y"] }])).toThrow(/duplicate/);
    expect(() => parseTiersValue({})).toThrow(/list/);
  });

  it("migrates the live-shaped three-role config: t1 anthropic/sonnet first, t2 the worker list, t0 seeded, role keys dropped", () => {
    const classes: Record<string, any> = { ...THREE_ROLES(), mine: { maxCostTier: 2 } };
    const cfg = { classes, tiers: [] as TierDef[] };
    expect(migrateToTiers(cfg)).toBe(true);
    expect(cfg.tiers.map((t) => [t.id, t.name])).toEqual([["t0", "Session"], ["t1", "Orchestrator"], ["t2", "Worker"]]);
    const [t0, t1, t2] = cfg.tiers;
    expect(t0).toMatchObject({ models: ["anthropic/opus", "glm/glm-5.3[1m]"], session: true, note: "context width, reasoning" });
    expect(t1).toMatchObject({ models: ["anthropic/sonnet", "glm/glm-5.3-flash", "gyro-m"], classes: ["orchestrate", "plan"], note: "planning, reasoning" });
    expect(t2).toMatchObject({ models: ["gyro-m", "anthropic", "glm/fast", "kimi"], default: true });
    expect(t2!.classes).toEqual(expect.arrayContaining(["implement", "simple", "spotcheck"]));
    // Quick check was identical to Worker: nothing to say
    expect(t2!.description).not.toMatch(/Quick check/);
    expect(classes).toEqual({ mine: { maxCostTier: 2 } });
    expect(migrateToTiers(cfg)).toBe(false);
  });

  it("a Quick check order that differed from Worker is kept in the t2 description; an old orchestrator list is appended after sonnet / glm flash (deduped)", () => {
    const classes: Record<string, any> = { orchestrator: { models: ["glm/glm-5.3-flash", "kimi"] }, worker: { models: ["gyro-m"] }, quick: { models: ["anthropic/haiku", "gyro-m"] } };
    const cfg = { classes, tiers: [] as TierDef[] };
    migrateToTiers(cfg);
    expect(cfg.tiers[1]!.models).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash", "kimi"]);
    expect(cfg.tiers[2]!.models).toEqual(["gyro-m"]);
    expect(cfg.tiers[2]!.description).toContain("anthropic/haiku > gyro-m");
  });

  it("migrates the per-class lists through the roles to tiers, and a session's role / class overrides to tier keys", () => {
    const classes: Record<string, any> = {
      orchestrate: { provider: "anthropic", models: ["anthropic/opus", "anthropic/sonnet", "glm/glm-5.3", "glm/glm-5.3-flash", "gyro-m"] },
      plan: "glm",
      implement: { provider: "gyro-m", models: ["gyro-m", "anthropic/sonnet", "glm/glm-5.3-flash", "kimi"] },
      research: { provider: "glm", models: ["glm/glm-5.3", "kimi"] },
      simple: { provider: "gyro-m", models: ["gyro-m", "anthropic/haiku", "glm/glm-5.3-flash", "kimi"] },
      mine: { maxCostTier: 2 },
    };
    expect(migrateClassRoutes(classes)).toBe(true);
    const cfg = { classes, tiers: [] as TierDef[] };
    migrateToTiers(cfg);
    expect(classRoute(cfg.tiers, "implement")).toEqual(["gyro-m", "anthropic/sonnet", "glm/glm-5.3-flash", "kimi"]);
    expect(classes.mine).toEqual({ maxCostTier: 2 });
    expect(Object.keys(classes)).toEqual(["mine"]);
    expect(migrateSessionRoutes({ orchestrator: ["a"], worker: ["b"], quick: ["c"], review: ["d"], t0: ["e"] })).toEqual({ t1: ["a"], t2: ["b"], t0: ["e"] });
    expect(migrateSessionRoutes({ spotcheck: ["c"], plan: ["p"] })).toEqual({ t2: ["c"], t1: ["p"] });
  });

  it("migrates through the config read from the three-role file and persists tiers on the next write", () => {
    const path = join(dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(path, JSON.stringify({ workers: { enabled: true, providers: PROVIDERS, logDir: join(dir, "logs"), classes: THREE_ROLES() } }));
    const w0 = readWorkersSection(path).workers;
    expect(w0.tiers.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(Object.keys(w0.classes)).toEqual([]);
    setRoute("review", ["kimi"], path);
    const saved = JSON.parse(readFileSync(path, "utf8")).workers;
    expect(saved.tiers.map((t: TierDef) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(Object.keys(saved.classes ?? {})).toEqual([]);
    const w = readWorkersSection(path).workers;
    expect(classRoute(w.tiers, "implement")).toEqual(["kimi"]);
    expect(classRoute(w.tiers, "orchestrate")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash", "gyro-m"]);
  });

  it("routing for --class implement uses t2, --orchestrate / plan uses t1", async () => {
    const path = liveShaped();
    setRoute("t2", ["anthropic/opus", "glm/fast"], path);
    const { workers } = readWorkersSection(path);
    expect(classRoute(workers.tiers, "review")).toEqual(["anthropic/opus", "glm/fast"]);
    const logDir = join(dir, "logs-r");
    expect(resolveTarget(workers, logDir, { className: "implement", sessionEnv: {} })).toMatchObject({ providerName: "anthropic", modelId: "opus" });
    expect(resolveTarget(workers, logDir, { className: routeClassOf({ orchestrate: true }), sessionEnv: {} })).toMatchObject({ providerName: "anthropic", modelAlias: "default", routeWhy: "class: orchestrate" });
    expect(resolveTarget(workers, logDir, { className: "plan", sessionEnv: {} })).toMatchObject({ providerName: "anthropic", modelAlias: "default", routeWhy: "class: plan" });
    expect(routeClassOf({ className: "implement", orchestrate: true })).toBe("implement");
    expect(routeClassOf({})).toBeUndefined();
  });

  it("route set with a class sets its tier's row; an unlisted class sets the default tier", () => {
    const path = liveShaped();
    expect(setRoute("spotcheck", ["kimi", "glm/fast"], path).text).toBe("t2=kimi>glm/fast");
    const { workers } = readWorkersSection(path);
    expect(classRoute(workers.tiers, "simple")).toEqual(["kimi", "glm/fast"]);
    expect(classRoute(workers.tiers, "implement")).toEqual(["kimi", "glm/fast"]);
    expect(setRoute("unheard-of", ["kimi"], path).id).toBe("t2");
    expect(() => setRoute("nothing", ["kimi"], liveShaped(TIERS.filter((t) => !t.default)))).toThrow(/no tier or class/);
  });
});

describe("tiers in workers.yaml", () => {
  it("the live-shaped yaml (classes orchestrator / worker / quick) migrates; the next write stores `tiers:` and drops the role keys", () => {
    const y = join(dir, `workers-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(
      y,
      [
        "# my comment",
        "providers:",
        "  glm:",
        "    url: https://api.example.com/anthropic",
        "    key_file: ~/k",
        "    models:",
        "      default: glm-5.3",
        "      fast: glm-5.3-flash",
        "  gyro-m:",
        "    url: http://127.0.0.1:8010",
        "    models:",
        "      default: q",
        "      fast: q",
        "classes:",
        "  orchestrator:",
        "    provider: anthropic",
        "    models: [anthropic/sonnet, glm/glm-5.3-flash, gyro-m]",
        "  worker:",
        "    provider: gyro-m",
        "    models: [gyro-m, anthropic, glm/fast]",
        "  quick:",
        "    provider: gyro-m",
        "    models: [gyro-m, anthropic, glm/fast]",
        "",
      ].join("\n")
    );
    const cfg = join(dir, "yaml-main.json");
    writeFileSync(cfg, JSON.stringify({ workers: { enabled: true, logDir: join(dir, "logs") } }));
    const saved = process.env.PAI_WORKERS_YAML;
    process.env.PAI_WORKERS_YAML = y;
    try {
      expect(readWorkersSection(cfg).workers.tiers.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
      setRoute("t2", ["gyro-m", "glm/fast"], cfg, "cheap first");
      const text = readFileSync(y, "utf8");
      expect(text).toContain("# my comment");
      expect(text).toMatch(/^tiers:/m);
      expect(text).not.toMatch(/^ {2}(orchestrator|worker|quick):/m);
      const w = readWorkersSection(cfg).workers;
      expect(w.tiers.find((t) => t.id === "t2")).toMatchObject({ models: ["gyro-m", "glm/fast"], note: "cheap first", default: true });
      expect(w.tiers[0]).toMatchObject({ models: ["anthropic/opus", "glm/glm-5.3[1m]"], session: true });
      expect(classRoute(w.tiers, "orchestrate")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash", "gyro-m"]);
    } finally {
      process.env.PAI_WORKERS_YAML = saved;
    }
  });
});

describe("session start (t0)", () => {
  const up = { logDir: join(dir, "logs-t0"), running: async () => true };
  it("pai launch's default is the first available entry of the session tier; anthropic out -> glm", async () => {
    const { workers } = readWorkersSection(liveShaped());
    expect(await sessionStartTarget(workers, up)).toMatchObject({ entry: "anthropic/opus", provider: "anthropic", model: "opus", tier: "t0" });
    const out = { ...up, budgets: { anthropic: { percent: 100, resetAt: null, fetchedAt: Date.now() } } };
    expect(await sessionStartTarget(workers, out)).toMatchObject({ entry: "glm/glm-5.3", provider: "glm", model: "glm-5.3" });
    expect(await sessionStartTarget({ ...workers, tiers: workers.tiers.filter((t) => !t.session) }, up)).toBeNull();
  });

  it("launch reads it: an empty answer takes the default, an explicit one wins", async () => {
    const { launchDefault, parseChoice } = await import("../cli/commands/lifecycle/launch.js");
    const { workers } = readWorkersSection(liveShaped());
    const dflt = await launchDefault(workers, up);
    expect(dflt).toMatchObject({ provider: "anthropic", model: "opus", tier: "t0" });
    expect(parseChoice("", [], dflt)).toEqual(dflt);
    expect(parseChoice("glm/glm-5.3-flash", [], dflt)).toEqual({ provider: "glm", model: "glm-5.3-flash" });
    expect(parseChoice("", [], null)).toBeNull();
  });
});

describe("set / validate", () => {
  it("round trips on a temp copy; the session tier moves the session chat provider, t1 does not", () => {
    const path = liveShaped();
    const r = setRoute("t0", ["glm", "anthropic/opus"], path, "wide context");
    expect(r.text).toBe("t0=glm>anthropic/opus");
    expect(JSON.parse(readFileSync(path, "utf8")).session.profile.chat.provider).toBe("glm");
    const w = readWorkersSection(path).workers;
    expect(w.tiers[0]).toMatchObject({ models: ["glm", "anthropic/opus"], note: "wide context", session: true });
    setRoute("orchestrate", ["anthropic/opus", "glm"], path);
    expect(JSON.parse(readFileSync(path, "utf8")).session.profile.chat.provider).toBe("glm");
    expect(classRoute(readWorkersSection(path).workers.tiers, "orchestrate")).toEqual(["anthropic/opus", "glm"]);
  });

  it("refuses empty or malformed models, unknown providers and models, a model on a local entry", () => {
    const { workers } = readWorkersSection(liveShaped());
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

  it("`pai worker policy <mode>` rewrites the default tier and leaves the Session and Orchestrator tiers", () => {
    expect(POLICY_MODES).toContain("prefer-local");
    const path = liveShaped();
    setRoute("implement", ["anthropic", "glm/fast"], path);
    applyPolicyToRoutes("prefer-local", path);
    let c = readWorkersSection(path).workers.tiers;
    expect(classRoute(c, "implement")).toEqual(["gyro-m", "anthropic", "glm/fast"]);
    expect(classRoute(c, "orchestrate")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash", "gyro-m"]);
    applyPolicyToRoutes("cloud-only", path);
    c = readWorkersSection(path).workers.tiers;
    expect(classRoute(c, "implement")).toEqual(["anthropic", "glm/fast"]);
    expect(classRoute(c, "spotcheck")).toEqual(["anthropic", "glm/fast"]);
    expect(classRoute(c, "orchestrate")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash", "gyro-m"]);
    expect(classRoute(c, "t0")).toEqual(["anthropic/opus", "glm/glm-5.3"]);
    applyPolicyToRoutes("prefer-cloud", path);
    expect(classRoute(readWorkersSection(path).workers.tiers, "simple")).toEqual(["anthropic", "glm/fast", "gyro-m"]);
    applyPolicyToRoutes("local-only", path);
    expect(classRoute(readWorkersSection(path).workers.tiers, "simple")).toEqual(["gyro-m"]);
  });

  it("a policy file with no class list still routes as before", async () => {
    const { workers } = readWorkersSection(liveShaped());
    const bare = { ...workers, tiers: [] };
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
    expect(rows.map((r) => r.label)).toEqual(["t0 Session", "t1 Orchestrator", "t2 Worker"]);
    expect(rows[1]!.classes).toEqual(["orchestrate", "plan"]);
    const impl = rows.find((r) => r.id === "t2")!;
    expect(impl.chips.map((c) => [c.label, c.state])).toEqual([
      ["local gyro-m", "available"],
      ["local iq3s", "idle"],
      ["anthropic/sonnet", "available"],
      ["glm/glm-5.3-flash", "tight"],
      ["kimi/k3", "unavailable"],
    ]);
    expect(rows[0]!.id).toBe("t0");
    expect(routeText(rows)).toContain("local gyro-m → local iq3s (not running) → anthropic/sonnet → glm/glm-5.3-flash (budget 85%)");
  });

  it("the flow line resolves each tier to its first available entry; anthropic out -> the next entry", async () => {
    const { workers } = readWorkersSection(liveShaped());
    const deps = { logDir: join(dir, "logs-flow"), running: async (n: string) => n === "gyro-m" };
    const ok = await routeRows(workers, deps);
    expect(flowText(ok)).toBe("t0 Session: opus → t1 Orchestrator: sonnet → t2 Worker: local gyro-m");
    expect(routeText(ok).split("\n")[0]).toContain("t0 Session: opus → t1 Orchestrator: sonnet → t2 Worker: local gyro-m");
    const out = await routeRows(workers, { ...deps, budgets: { anthropic: { percent: 100, resetAt: null, fetchedAt: Date.now() } } });
    expect(flowText(out)).toBe("t0 Session: glm/glm-5.3 → t1 Orchestrator: glm/glm-5.3-flash → t2 Worker: local gyro-m");
    const none = await routeRows(workers, { ...deps, running: async () => false, budgets: { anthropic: { percent: 100, resetAt: null, fetchedAt: Date.now() } } });
    expect(flowText(none)).toContain("t2 Worker: glm/glm-5.3-flash");
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
    expect(classRoute(mine.tiers, "implement")).toEqual(["anthropic/sonnet", "kimi"]);
    expect(classRoute(other.tiers, "implement")).toEqual(["glm/fast"]);
    expect(classRoute(workers.tiers, "implement")).toEqual(["glm/fast"]);
    const pick = async (w: typeof workers) => routeRun(w, logDir, { className: "implement" }, { ping: loaded(8010) });
    expect(await pick(other)).toBeNull();
    expect(resolveTarget(mine, logDir, { className: "implement" }).providerName).toBe("anthropic");
    expect(resolveTarget(other, logDir, { className: "implement" }).providerName).toBe("glm");
    setSessionRoute("local-sess", "implement", ["gyro-m"], { path, profilesPath: pp });
    const loc = effectiveWorkers(workers, readProfiles(pp)["local-sess"]);
    expect((await pick(loc))?.providerFlag).toBe("gyro-m");
    expect(await pick(other)).toBeNull();
    expect(clearSessionRoute("job-search", "implement", pp, path)).toMatch(/cleared/);
    expect(readProfiles(pp)["job-search"]?.routes).toBeUndefined();
    expect(classRoute(effectiveWorkers(workers, readProfiles(pp)["job-search"]).tiers, "implement")).toEqual(["glm/fast"]);
  });

  it("the effective table marks overridden rows; the global view lists the sessions and notes", async () => {
    const path = liveShaped();
    const pp = profiles();
    setRoute("implement", ["glm/fast"], path, "context width, reasoning");
    setSessionRoute("job-search", "implement", ["anthropic/sonnet"], { path, profilesPath: pp, note: "wide" });
    const { workers } = readWorkersSection(path);
    const deps = { logDir: join(dir, "logs-t"), running: async () => true };
    const eff = routeText(await routeRows(workers, { ...deps, session: readProfiles(pp)["job-search"] }));
    expect(eff).toMatch(/t2 Worker\s+anthropic\/sonnet  \[implement, research, draft, review, complex, simple, spotcheck\]  \[session override\]  # wide/);
    expect(eff).toMatch(/t1 Orchestrator\s+anthropic\/sonnet/);
    const rows = await routeRows(workers, { ...deps, profiles: readProfiles(pp) });
    const impl = rows.find((r) => r.id === "t2")!;
    expect(impl.note).toBe("context width, reasoning");
    expect(impl.sessions).toMatchObject([{ session: "job-search", note: "wide", chips: [{ entry: "anthropic/sonnet" }] }]);
    expect(routeText(rows)).toContain("    job-search: anthropic/sonnet  # wide");
    expect(readWorkersSection(path).workers.tiers.find((t) => t.id === "t2")).toMatchObject({ models: ["glm/fast"], note: "context width, reasoning" });
  });

  it("refuses an unknown model for a session override; a class sets its role's override", () => {
    const path = liveShaped();
    expect(setSessionRoute("s", "review", ["glm"], { path, profilesPath: profiles() }).id).toBe("t2");
    expect(() => setSessionRoute("s", "implement", ["nobody/x"], { path, profilesPath: profiles() })).toThrow(/no provider/);
  });
});
