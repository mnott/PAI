import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSessionProfileDeps, sessionProfileGet, sessionProfileSet, type SessionProfileDeps } from "../daemon-mcp/tools/session-profile.js";
import type { BudgetMap } from "./budget.js";
import { nativeAnthropicModels, readWorkersSection, writeWorkersSection } from "./config.js";
import {
  getProfile,
  profilesPath,
  readProfiles,
  resolveWorkers,
  updateProfile,
  type ResolveCtx,
  type SessionProfile,
} from "./session-profile.js";
import { resolveTarget, type TargetDeps } from "./target.js";

const prov = (baseUrl: string, models: { default: string; fast?: string }, extra: Record<string, unknown> = {}) => ({
  enabled: true,
  protocol: "anthropic" as const,
  baseUrl,
  keyFile: null,
  env: {},
  models,
  ...extra,
});

const cfg = {
  active: "glm",
  nativeModels: { ...nativeAnthropicModels() },
  routing: {
    policy: "budget",
    order: [],
    priority: ["glm", "kimi"],
    budgetWalls: {},
    budgetPercent: {},
    budgetWall: 95,
    cooldownMinutes: 30,
    retryOnQuota: true,
    budgetPriority: [],
  },
  providers: {
    kimi: prov("https://kimi.example.invalid", { default: "k3", fast: "k3-fast" }),
    glm: prov("https://glm.example.invalid", { default: "glm-big", fast: "glm-small" }),
    local: prov("http://127.0.0.1:8035", { default: "flash" }, { maxConcurrent: 1 }),
  },
} as unknown as ResolveCtx["cfg"];

const full = (window = "5h"): BudgetMap[string] => ({ percent: 100, resetAt: null, fetchedAt: Date.now(), windows: [{ name: window, percent: 100 }] });

const PROFILE: SessionProfile = {
  chat: { provider: "anthropic", model: "opus" },
  workers: { provider: "kimi", model: "fast" },
  fallback: [{ provider: "glm", model: "fast" }, { provider: "local" }],
};

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({ cfg, profile: PROFILE, env: {}, budgets: {}, routing: { cooldowns: {} }, ...over });

describe("resolveWorkers precedence", () => {
  it("explicit > profile > setup env > global", () => {
    const env = { PAI_SESSION_WORKER_PROVIDER: "glm" };
    expect(resolveWorkers({ explicit: { provider: "local" } }, ctx({ env }))).toMatchObject({ source: "explicit", provider: "local" });
    expect(resolveWorkers({}, ctx({ env }))).toMatchObject({ source: "profile", provider: "kimi", model: "fast", description: "kimi fast (session profile)" });
    expect(resolveWorkers({}, ctx({ env, profile: { chat: PROFILE.chat } }))).toMatchObject({ source: "env", provider: "glm" });
    expect(resolveWorkers({}, ctx({ profile: null }))).toMatchObject({ source: "global" });
  });
  it("an explicit model alone applies to the profile's provider", () => {
    expect(resolveWorkers({ explicit: { model: "default" } }, ctx())).toMatchObject({ provider: "kimi", model: "default" });
  });
});

describe("resolveWorkers budget fallback", () => {
  it("kimi exhausted -> the first fallback, with the reason", () => {
    const r = resolveWorkers({}, ctx({ budgets: { kimi: full() } }));
    expect(r).toMatchObject({ source: "fallback", provider: "glm", model: "fast", description: "glm fast (fallback: kimi 5h at 100%)" });
  });
  it("a recorded quota cooldown counts as exhausted", () => {
    const routing = { cooldowns: { kimi: new Date(Date.now() + 600_000).toISOString() } };
    expect(resolveWorkers({}, ctx({ routing }))).toMatchObject({ source: "fallback", provider: "glm" });
  });
  it("below the wall nothing changes", () => {
    const budgets = { kimi: { percent: 80, resetAt: null, fetchedAt: Date.now(), windows: [{ name: "5h", percent: 80 }] } };
    expect(resolveWorkers({}, ctx({ budgets }))).toMatchObject({ source: "profile", provider: "kimi" });
  });
  it("without a fallback list the global order is walked", () => {
    const r = resolveWorkers({}, ctx({ profile: { workers: { provider: "kimi" } }, budgets: { kimi: full() } }));
    expect(r).toMatchObject({ source: "fallback", provider: "glm" });
  });
  it("parallel_min skips the cap-1 local in a batch, not in a single spawn", () => {
    const profile = { ...PROFILE, parallel_min: 2 };
    const budgets = { kimi: full(), glm: full() };
    expect(resolveWorkers({}, ctx({ profile, budgets }))).toMatchObject({ source: "fallback", provider: "local" });
    const batch = resolveWorkers({ batch: true }, ctx({ profile, budgets }));
    expect(batch.source).toBe("none");
    expect(batch.provider).toBeUndefined();
    expect(batch.description).toContain("local cap 1 < parallel_min 2");
  });
});

describe("profile store", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "profiles-"));
    vi.stubEnv("PAI_HOME", home);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("partial updates keep the rest; null clears a part", () => {
    updateProfile("job", PROFILE);
    updateProfile("job", { parallel_min: 2 });
    expect(getProfile("job")).toEqual({ ...PROFILE, parallel_min: 2 });
    updateProfile("job", { fallback: null, parallel_min: null });
    expect(getProfile("job")).toEqual({ chat: PROFILE.chat, workers: PROFILE.workers });
    expect(existsSync(profilesPath())).toBe(true);
  });
  it("migrates session-workers.json into the one store and drops it", () => {
    const legacy = join(home, "session-workers.json");
    writeFileSync(legacy, JSON.stringify({ alpha: "glm", beta: "kimi" }));
    updateProfile("beta", { chat: { provider: "anthropic", model: "opus" } });
    expect(readProfiles()).toMatchObject({ alpha: { workers: { provider: "glm" } }, beta: { workers: { provider: "kimi" }, chat: { model: "opus" } } });
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(profilesPath(), "utf8")).toContain("alpha:");
  });
});

describe("resolveTarget with a session profile (every MCP/CLI delegation entry)", () => {
  const deps = (over: Partial<ResolveCtx> = {}): TargetDeps => ({
    workers: cfg as unknown as TargetDeps["workers"],
    logDir: mkdtempSync(join(tmpdir(), "tgt-")),
    env: {},
    profileCtx: async () => ctx(over),
  });
  it("end to end: workers kimi fast", async () => {
    expect(await resolveTarget({}, deps())).toMatchObject({ provider: "kimi", model: "k3-fast", description: "kimi fast (session profile)" });
  });
  it("kimi exhausted -> glm fast", async () => {
    expect(await resolveTarget({}, deps({ budgets: { kimi: full() } }))).toMatchObject({ provider: "glm", model: "glm-small", description: "glm fast (fallback: kimi 5h at 100%)" });
  });
  it("batch with parallel_min 2 and glm exhausted: none available, not serialised", async () => {
    const over = { profile: { ...PROFILE, parallel_min: 2 }, budgets: { kimi: full(), glm: full() } };
    await expect(resolveTarget({ batch: true }, deps(over))).rejects.toThrow(/no worker target available/);
    expect(await resolveTarget({}, deps(over))).toMatchObject({ provider: "local" });
  });
  it("an explicit where wins over the profile", async () => {
    expect(await resolveTarget({ where: "glm" }, deps())).toMatchObject({ provider: "glm" });
  });
});

describe("session_profile_get / set", () => {
  let d: SessionProfileDeps;
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    const path = join(mkdtempSync(join(tmpdir(), "mcp-prof-")), "session-profiles.yaml");
    d = { path, env: { PAI_SESSION_NAME: "job-search" }, ctx: async () => ctx({ profile: null }), send: async (s, t) => (sent.push(`${s}:${t}`), { ok: true }) };
  });
  it("round trip for the current session, resolved description included", async () => {
    const set = await sessionProfileSet({ workers: { provider: "kimi", model: "fast" }, fallback: [{ provider: "glm", model: "fast" }] }, d);
    expect(set.isError).toBeUndefined();
    expect(set.content[0].text).toContain("next worker spawn: kimi fast (session profile)");
    const get = await sessionProfileGet({}, d);
    expect(get.content[0].text).toContain("workers: kimi fast");
    expect(get.content[0].text).toContain("fallback: glm fast");
    expect(getProfile("job-search", d.path)?.workers).toEqual({ provider: "kimi", model: "fast" });
  });
  it("a chat change is stored and says it applies on next start; apply_now sends /model", async () => {
    const r = await sessionProfileSet({ chat: { provider: "anthropic", model: "opus" } }, d);
    expect(r.content[0].text).toContain("applies when the session next starts");
    expect(sent).toEqual([]);
    const now = await sessionProfileSet({ chat: { provider: "anthropic", model: "opus" }, apply_now: true }, d);
    expect(now.content[0].text).toContain("sent /model opus");
    expect(sent).toEqual(["job-search:/model opus"]);
  });
  it("route overrides round trip: set (a class sets its tier), shown in get, one row cleared, all cleared", async () => {
    // the tiers are config: the guarded test home's config carries a fixture pair
    const { raw, workers } = readWorkersSection();
    workers.tiers = [
      { id: "t1", name: "Orchestrator", models: ["anthropic/sonnet"], classes: ["orchestrate", "plan"] },
      { id: "t2", name: "Worker", models: ["gyro-m"], classes: ["implement", "spotcheck"], default: true },
    ];
    writeWorkersSection(raw, workers);
    const set = await sessionProfileSet({ routes: { implement: ["anthropic/sonnet"], spotcheck: ["anthropic/haiku"] } }, d);
    expect(set.isError).toBeUndefined();
    expect(getProfile("job-search", d.path)?.routes).toEqual({ t2: ["anthropic/haiku"] });
    expect((await sessionProfileGet({}, d)).content[0].text).toContain("route overrides: t2=anthropic/haiku");
    await sessionProfileSet({ routes: { orchestrate: ["anthropic/opus"] } }, d);
    expect(getProfile("job-search", d.path)?.routes).toEqual({ t1: ["anthropic/opus"], t2: ["anthropic/haiku"] });
    await sessionProfileSet({ routes: { spotcheck: null } }, d);
    expect(getProfile("job-search", d.path)?.routes).toEqual({ t1: ["anthropic/opus"] });
    await sessionProfileSet({ routes: null }, d);
    expect(getProfile("job-search", d.path)?.routes).toBeUndefined();
  });
  it("another session by name; an unnamed session is told to pass a name", async () => {
    await sessionProfileSet({ name: "other", workers: { provider: "glm" } }, d);
    expect(getProfile("other", d.path)?.workers?.provider).toBe("glm");
    const r = await sessionProfileGet({}, { ...d, env: {} });
    expect(r.isError).toBe(true);
  });
  it("the live deps are built without touching anything", async () => {
    expect((await realSessionProfileDeps()).path).toBe(profilesPath());
  });
});
