/**
 * tier-route.test.ts — the tier list is the only routing source: every class,
 * simple and spotcheck included, resolves to its tier's first available entry;
 * no code rule sends the cheap classes to a provider's fast model behind the
 * list. Legacy per-class pins migrate into the tier list or are ignored with a
 * warning.
 */

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkersSection } from "./config.js";
import { resolveTarget } from "./routing.js";
import { routeRun } from "./policy.js";
import { entryLabel } from "./route-table.js";
import type { TierDef } from "./route-lists.js";

for (const k of ["PAI_SESSION_PROVIDER", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "PAI_WORKER_ID"]) delete process.env[k];

const dir = mkdtempSync(join(tmpdir(), "pai-tier-route-"));
const logDir = join(dir, "logs");

const PROVIDERS = {
  glm: { baseUrl: "https://api.example.com/anthropic", keyFile: "~/k", models: { default: "glm-5.3", fast: "glm-5.3-flash" }, env: {} },
  kimi: { baseUrl: "https://api.example.com/kimi", keyFile: "~/k", models: { default: "k3", fast: "kf" }, env: {} },
  "gyro-m": { baseUrl: "http://127.0.0.1:8010", models: { default: "q", fast: "q" }, env: {} },
};

const TIERS: TierDef[] = [
  { id: "t1", name: "Orchestrator", models: ["anthropic/sonnet"], classes: ["orchestrate", "plan"] },
  { id: "t2", name: "Worker", models: ["gyro-m", "anthropic", "glm/fast", "kimi"], classes: ["implement", "research", "draft", "review", "complex", "simple", "spotcheck"], default: true },
];

function shaped(extra: Record<string, unknown> = {}): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, JSON.stringify({ workers: { enabled: true, active: "glm", providers: PROVIDERS, tiers: TIERS, logDir } , ...extra }));
  return path;
}

const loaded = (ports: number[]) => async (url: string) => ports.some((p) => url.endsWith(`:${p}`));

describe("every class routes by its tier list", () => {
  it("simple and spotcheck resolve to the tier's first available entry, not a fast-model rule", () => {
    const { workers } = readWorkersSection(shaped());
    for (const className of ["simple", "spotcheck", "implement", "review", "draft", "research", "complex"]) {
      // resolveTarget never starts a local server: the local entry is skipped
      // ("local (not running)"), the next tier entry serves — routeRun pins the
      // running local. No class rule sends the cheap classes elsewhere.
      const t = resolveTarget(workers, logDir, { className, sessionEnv: {} });
      expect(t.providerName).toBe("anthropic");
      expect(t.via).toBe("class");
      // no fast alias smuggled in: the entry names no model, the provider's worker_model decides
      expect(t.modelAlias).toBeNull();
      expect(t.modelId).toBeUndefined();
    }
  });

  it("routeRun pins the running local for simple and spotcheck like any t2 class", async () => {
    const { workers } = readWorkersSection(shaped());
    for (const className of ["simple", "spotcheck", "implement"]) {
      const r = await routeRun(workers, logDir, { className }, { ping: loaded([8010]) });
      expect(r!.providerFlag).toBe("gyro-m");
    }
  });

  it("a tier entry naming a model serves that model for every class of the tier", () => {
    const path = shaped();
    const { workers } = readWorkersSection(path);
    workers.tiers = workers.tiers.map((t) => (t.id === "t2" ? { ...t, models: ["glm/glm-5.3-flash", "kimi"] } : t));
    for (const className of ["simple", "spotcheck", "implement"]) {
      const t = resolveTarget(workers, logDir, { className, sessionEnv: {} });
      expect(t.providerName).toBe("glm");
      // "glm-5.3-flash" is glm's `fast` alias, so it resolves as the alias
      expect(t.modelAlias).toBe("fast");
    }
  });

  it("the chip label of an unnamed entry is the provider's default model, not a class-implied fast model", () => {
    const { workers } = readWorkersSection(shaped());
    const tier = workers.tiers.find((t) => t.id === "t2")!;
    expect(entryLabel(workers, tier, "glm")).toBe("glm/glm-5.3");
  });
});

describe("legacy class pins migrate into the tier list", () => {
  it("a legacy per-class pin on a standard class moves into its tier's list, front, with a warning", () => {
    const path = join(dir, `legacy-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(
      path,
      JSON.stringify({
        workers: {
          enabled: true,
          active: "glm",
          providers: PROVIDERS,
          tiers: TIERS,
          classes: { spotcheck: "kimi/fast", mine: { maxCostTier: 2 } },
          logDir,
        },
      })
    );
    const warnings: string[] = [];
    const { workers } = readWorkersSection(path, (msg) => warnings.push(msg));
    // migrated: kimi/fast is the tier's first entry, spotcheck included
    expect(workers.tiers.find((t) => t.id === "t2")!.models[0]).toBe("kimi/fast");
    expect(workers.classes.mine).toEqual({ maxCostTier: 2 });
    expect(warnings.join("\n")).toMatch(/kimi\/fast/);
    const t = resolveTarget(workers, logDir, { className: "spotcheck", sessionEnv: {} });
    expect(t.providerName).toBe("kimi");
    expect(t.modelAlias).toBe("fast");
  });

  it("a legacy pin equal to a tier entry is dropped with a warning, the tier list unchanged", () => {
    const path = join(dir, `legacy-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(
      path,
      JSON.stringify({
        workers: { enabled: true, active: "glm", providers: PROVIDERS, tiers: TIERS, classes: { simple: "gyro-m" }, logDir },
      })
    );
    const warnings: string[] = [];
    const { workers } = readWorkersSection(path, (msg) => warnings.push(msg));
    expect(workers.tiers.find((t) => t.id === "t2")!.models).toEqual(TIERS[1]!.models);
    expect(workers.classes.simple).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/gyro-m/);
  });
});
