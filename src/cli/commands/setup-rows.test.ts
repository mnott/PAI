import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProviderOrNative, nativeAnthropicModels } from "../../workers/config.js";
import { readProfiles, resolveWorkers, updateProfile } from "../../workers/session-profile.js";
import { makeStyle } from "../help.js";
import { allSetups, setupProfile, setupWorkersLabel } from "../lib/setups.js";
import { lastSetup, setupsTable } from "./root.js";
import type { SessionRow } from "./session.js";

const st = makeStyle(false);
const mk = (baseUrl: string, fast: string) => ({ enabled: true, protocol: "anthropic" as const, baseUrl, keyFile: null, env: {}, models: { default: "m-default", fast } });
const cfg = {
  active: "glm",
  nativeModels: { ...nativeAnthropicModels() },
  providers: {
    glm: mk("https://glm.invalid", "glm-air"),
    kimi: mk("https://kimi.invalid", "m-default"),
    flash: mk("http://127.0.0.1:9999", "m-default"),
  },
  routing: { budgetWalls: {} } as never,
};
const row = { name: "Jobs", provider: "anthropic", model: "claude-opus-5-5" } as SessionRow;

/**
 * What the Workers column promises: the label names the model the resolver
 * will use — "<model> (<provider>)" with the provider's fast-model name means
 * fast, with its default-model name means the default (no model written).
 */
const promised = (label: string): { provider: string; model?: string } => {
  const m = /^(\S+) \((\S+)\)$/.exec(label)!;
  const [, named, provider] = m;
  const models = getProviderOrNative(cfg, provider)?.models;
  if (models?.fast === named && models.fast !== models.default) return { provider, model: "fast" };
  return { provider };
};

describe("every setup row writes and resolves what it displays", () => {
  const setups = allSetups(cfg, lastSetup(row, cfg, null), [], new Set(), "flash");
  const o = setupsTable(setups, cfg, {}, st);

  it("the table covers every built-in kind", () => {
    const names = setups.map((s) => s.name);
    for (const n of ["Last time", "anthropic only", "anthropic + haiku workers", "anthropic + glm workers", "anthropic + local workers", "glm only"]) expect(names).toContain(n);
  });

  it.each(setups.map((s) => [s.name, s] as const))("%s", (_n, s) => {
    const dir = mkdtempSync(join(tmpdir(), "pai-setup-"));
    const path = join(dir, "session-profiles.yaml");
    const displayed = o.cells(s)[3];
    updateProfile("Jobs Grazyna", setupProfile(cfg, s), path);
    const profile = readProfiles(path)["Jobs Grazyna"];
    // the launch pin is written implicit: it records the setup for the launch,
    // but resolveWorkers must not route on it — global routing stands
    expect(profile.workers).toEqual(s.local ? { provider: s.workers, ...(promised(setupWorkersLabel(cfg, { ...s, local: undefined })).model ? { model: "fast" } : {}) } : promised(displayed));
    expect(profile.workers_implicit).toBe(true);
    const r = resolveWorkers({}, { cfg, profile, env: {}, budgets: {}, routing: { cooldowns: {} } as never });
    expect(r.source).toBe("global");
    expect(r.provider).toBeUndefined();
    // chat: the written model is the one the Orchestrator column names
    expect(profile.chat?.provider).toBe(s.orchestrator.provider);
    expect(profile.chat?.model).toBe(s.orchestrator.model ?? (cfg.providers as Record<string, { models: { default: string } }>)[s.orchestrator.provider]?.models.default);
  });

  it("anthropic only writes the anthropic default (sonnet) implicit; a spawn keeps global routing", () => {
    const s = setups.find((x) => x.name === "anthropic only")!;
    expect(setupProfile(cfg, s).workers).toEqual({ provider: "anthropic" });
    expect(setupProfile(cfg, s).workers_implicit).toBe(true);
    expect(o.cells(s)[3]).toBe("sonnet (anthropic)");
    const r = resolveWorkers({}, { cfg, profile: setupProfile(cfg, s), env: {}, budgets: {}, routing: { cooldowns: {} } as never });
    expect(r.source).toBe("global");
    expect(r.provider).toBeUndefined();
  });

  it("anthropic + haiku workers writes anthropic fast implicit; a spawn keeps global routing", () => {
    const s = setups.find((x) => x.name === "anthropic + haiku workers")!;
    expect(setupProfile(cfg, s).workers).toEqual({ provider: "anthropic", model: "fast" });
    expect(o.cells(s)[3]).toBe("haiku (anthropic)");
    const r = resolveWorkers({}, { cfg, profile: setupProfile(cfg, s), env: {}, budgets: {}, routing: { cooldowns: {} } as never });
    expect(r.source).toBe("global");
    expect(r.provider).toBeUndefined();
  });

  it("Last time keeps the session's own worker model", () => {
    const l = lastSetup(row, cfg, { workers: { provider: "glm", model: "glm-air" } });
    expect(setupProfile(cfg, l).workers).toEqual({ provider: "glm", model: "glm-air" });
  });
});
