import { describe, expect, it } from "vitest";
import {
  formatCarryByProvider,
  poolCarryByProvider,
  pooledUnitPrompt,
  splitSharedSpec,
  type PoolMetricRow,
} from "./pool.js";
import { ORCHESTRATOR_CONTRACT } from "./report.js";
import { prefixBlockHashes } from "../router/router.js";

const row = (provider: string, over: Partial<PoolMetricRow>): PoolMetricRow => ({
  ts: "t",
  id: "w",
  provider,
  model: "m",
  task: 1,
  slotSession: null,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...over,
});

describe("pool carry by provider", () => {
  const rows = [
    row("anthropic", { cache_read_input_tokens: 600, cache_creation_input_tokens: 400 }),
    row("anthropic", { cache_read_input_tokens: 200, input_tokens: 800 }),
    row("glm", { cache_read_input_tokens: 900, input_tokens: 100 }),
    row("local30x8", { firstShare: 0.8 }),
    row("local30x8", { firstShare: 0.6 }),
    row("local30x8", {}), // zero-report, no share: dropped
    row("local30x8", { input_tokens: 50000 }), // zero cache tokens: dropped
  ];
  it("splits per provider; local uses the server share and drops zero-report rows", () => {
    const c = poolCarryByProvider(rows);
    expect(c.map((x) => x.provider)).toEqual(["anthropic", "glm", "local30x8"]);
    expect(c[0]).toMatchObject({ tasks: 2, server: false });
    expect(c[0]!.hitRatio).toBeCloseTo(800 / 2000, 5);
    expect(c[1]!.hitRatio).toBeCloseTo(0.9, 5);
    expect(c[2]).toMatchObject({ tasks: 2, server: true });
    expect(c[2]!.hitRatio).toBeCloseTo(0.7, 5);
  });
  it("formats one line", () => {
    expect(formatCarryByProvider(rows)).toBe(
      "anthropic 40% (2 tasks) · glm 90% (1 task) · local30x8 70% (2 tasks, server)"
    );
    expect(formatCarryByProvider([])).toBe("n/a");
  });
});

describe("shared spec marker", () => {
  it("splits shared from unit", () => {
    const r = splitSharedSpec("--- shared ---\nrules\nmore\n--- unit ---\ngoal");
    expect(r).toEqual({ shared: "rules\nmore", unit: "goal" });
  });
  it("keeps text ahead of the markers with the unit", () => {
    expect(splitSharedSpec("intro\n--- shared ---\nr\n--- unit ---\ng").unit).toBe("intro\n\ng");
  });
  it("unmarked or half-marked specs are unchanged", () => {
    for (const p of ["plain spec", "--- shared ---\nonly", "--- unit ---\nx\n--- shared ---\ny", "--- shared ---\n--- unit ---\nx"]) {
      expect(splitSharedSpec(p)).toEqual({ shared: null, unit: p });
    }
  });
  it("worker id and branch follow the spec", () => {
    const t = pooledUnitPrompt("SPEC", "NOTE worker id w1");
    expect(t.indexOf("SPEC")).toBeLessThan(t.indexOf("worker id w1"));
    expect(pooledUnitPrompt("SPEC", "")).toBe("SPEC");
  });
  it("the orchestrator contract documents the marker", () => {
    expect(ORCHESTRATOR_CONTRACT).toContain("--- shared ---");
    expect(ORCHESTRATOR_CONTRACT).toContain("--- unit ---");
  });
});

describe("router prefix debug hashes", () => {
  it("hashes the three blocks of a first request only", () => {
    const a = prefixBlockHashes({ system: "s", tools: [1], messages: [{ content: "u1" }] });
    const b = prefixBlockHashes({ system: "s", tools: [1], messages: [{ content: "u2" }] });
    expect(a!.system).toBe(b!.system);
    expect(a!.tools).toBe(b!.tools);
    expect(a!.user).not.toBe(b!.user);
    expect(prefixBlockHashes({ messages: [{}, {}] })).toBeNull();
  });
});
