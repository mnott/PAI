import { describe, it, expect } from "vitest";
import { scriptWin } from "./cockpit-page/script-win.js";

describe("cockpit default group order", () => {
  it("composes kpis, pool, system, memory, routing, limits, workers, models, cache, then charts, tables, settings", () => {
    const js = scriptWin({} as never, ((x: unknown) => x) as never, ((x: unknown) => x) as never, ((x: unknown) => x) as never);
    const at = (s: string) => js.indexOf(`[${s}(),`, js.indexOf("Win.init(root"));
    const order = ["kpiDefaults", "poolDefaults", "sysDefaults", "memDefaults", "routingDefaults", "limLocalDefaults", "limCloudDefaults", "workersDefaults", "modelsDefaults", "cacheDefaults"].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(js.indexOf("chartsDefaults().parts", js.indexOf("Win.init(root"))).toBeGreaterThan(order[order.length - 1]);
    expect(js.indexOf("registryDefaults()", js.indexOf("Win.init(root"))).toBeGreaterThan(js.indexOf("tablesDefaults().parts"));
  });
});
