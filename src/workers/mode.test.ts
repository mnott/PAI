import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMode, readMode, writeMode } from "./mode.js";
import { DEFAULT_PACE, currentPace, decidePace, paceOf } from "./pace.js";
import type { TierDef } from "./route-lists.js";

const tiers = (): TierDef[] => [
  { id: "t0", name: "Session", models: ["anthropic/opus", "glm/glm-5.3[1m]"], session: true },
  { id: "t1", name: "Orchestrator", models: ["anthropic/sonnet", "gyro-l", "glm/glm-5.3-flash"], classes: ["orchestrate", "plan"] },
  { id: "t2", name: "Worker", models: ["gyro-l", "anthropic/sonnet", "glm/glm-5.3-flash"], classes: ["implement", "simple"], default: true },
];
const isLocal = (e: string): boolean => e.startsWith("gyro");
const models = (t: TierDef[], id: string): string[] => t.find((x) => x.id === id)!.models;

describe("applyMode", () => {
  it("balanced leaves the tiers as configured", () => {
    expect(applyMode(tiers(), "balanced", { isLocal })).toEqual(tiers());
  });

  it("speed: t2 leads with sonnet, no local model outside the session tier", () => {
    const t = applyMode(tiers(), "speed", { isLocal });
    expect(models(t, "t2")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash"]);
    expect(models(t, "t1")).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash"]);
    expect(models(t, "t0")).toEqual(["anthropic/opus", "glm/glm-5.3[1m]"]);
  });

  it("speed under an L1: the children run on haiku first", () => {
    const t = applyMode(tiers(), "speed", { isLocal, underOrchestrator: true });
    expect(models(t, "t2")[0]).toBe("anthropic/haiku");
    expect(models(t, "t2").some(isLocal)).toBe(false);
  });

  it("budget: t2 is local only, L1 stays cloud (it is also the takeover tier)", () => {
    const t = applyMode(tiers(), "budget", { isLocal });
    expect(models(t, "t2")).toEqual(["gyro-l"]);
    expect(models(t, "t1")).toEqual(["anthropic/sonnet", "gyro-l", "glm/glm-5.3-flash"]);
  });

  it("budget without any local entry keeps the list instead of emptying the tier", () => {
    expect(models(applyMode(tiers(), "budget", { isLocal: () => false }), "t2")).toEqual(tiers()[2].models);
  });

  it("does not mutate its input", () => {
    const t = tiers();
    applyMode(t, "speed", { isLocal });
    expect(t).toEqual(tiers());
  });
});

describe("mode in workers.yaml", () => {
  it("defaults to balanced, round-trips, keeps other keys, and balanced is written explicitly", () => {
    const f = join(mkdtempSync(join(tmpdir(), "mode-")), "workers.yaml");
    writeFileSync(f, "# mine\nenabled: true\n");
    expect(readMode(f)).toBe("balanced");
    writeMode("speed", f);
    expect(readMode(f)).toBe("speed");
    expect(readFileSync(f, "utf8")).toContain("# mine");
    writeMode("budget", f);
    expect(readMode(f)).toBe("budget");
    writeMode("balanced", f);
    expect(readFileSync(f, "utf8")).toContain("mode: balanced");
    expect(readMode(f)).toBe("balanced");
  });

  it("refuses an unknown value", () => {
    const f = join(mkdtempSync(join(tmpdir(), "mode-")), "workers.yaml");
    writeFileSync(f, "mode: warp\n");
    expect(() => readMode(f)).toThrow(/mode must be/);
  });
});

describe("routing by mode x {implement direct, orchestrate}", () => {
  const direct = (m: "speed" | "balanced" | "budget") => models(applyMode(tiers(), m, { isLocal }), "t2");
  const l1 = (m: "speed" | "balanced" | "budget") => models(applyMode(tiers(), m, { isLocal }), "t1");
  const kids = (m: "speed" | "balanced" | "budget") => models(applyMode(tiers(), m, { isLocal, underOrchestrator: true }), "t2");

  it("speed: direct sonnet; L1 sonnet, children haiku", () => {
    expect(direct("speed")[0]).toBe("anthropic/sonnet");
    expect(direct("speed").some(isLocal)).toBe(false);
    expect(l1("speed")[0]).toBe("anthropic/sonnet");
    expect(kids("speed")[0]).toBe("anthropic/haiku");
  });

  it("balanced: direct local first, sonnet takeover; L1 sonnet, local children, sonnet takeover", () => {
    expect(direct("balanced").slice(0, 2)).toEqual(["gyro-l", "anthropic/sonnet"]);
    expect(l1("balanced")[0]).toBe("anthropic/sonnet");
    expect(kids("balanced").slice(0, 2)).toEqual(["gyro-l", "anthropic/sonnet"]);
  });

  it("budget: direct local only (no cloud); L1 sonnet, local children only", () => {
    expect(direct("budget")).toEqual(["gyro-l"]);
    expect(l1("budget")[0]).toBe("anthropic/sonnet");
    expect(kids("budget")).toEqual(["gyro-l"]);
  });

  it("no mode key defaults to balanced", () => {
    const f = join(mkdtempSync(join(tmpdir(), "mode-")), "workers.yaml");
    writeFileSync(f, "enabled: true\n");
    expect(readMode(f)).toBe("balanced");
  });
});
