import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsCache } from "./limits.js";
import { runCockpitAction, readCockpitJob } from "./cockpit-actions.js";
import { WIN_ACTIONS_JS } from "./cockpit-page/win/actions.js";
const PAGE_JS_FOR_TEST = readFileSync(join(__dirname, "cockpit-page/script-win.ts"), "utf8");

describe("a local start/stop is reflected within one poll", () => {
  it("LimitsCache.invalidate: the next get() polls afresh and a poll in flight is not kept", async () => {
    let polls = 0;
    const cache = new LimitsCache({ providers: () => ({}), rows: () => [], lastGoodFile: join(mkdtempSync(join(tmpdir(), "pai-fresh-")), "lg.json") }, 60_000);
    const spy = cache as unknown as { poll: (n: number) => Promise<unknown[]> };
    spy.poll = async () => [{ provider: "iq3", kind: "local", windows: [], up: ++polls === 1 }];
    expect((await cache.get(1000))[0]!.up).toBe(true);
    expect((await cache.get(2000))[0]!.up).toBe(true); // cached within the ttl
    expect(polls).toBe(1);
    cache.invalidate();
    expect((await cache.get(3000))[0]!.up).toBe(false);
    expect(polls).toBe(2);
    // a poll that started before the invalidation does not overwrite the fresh one
    const slow = cache.get(70_000);
    cache.invalidate();
    const fresh = await cache.get(70_001);
    await slow;
    expect(fresh[0]!.up).toBe(false);
    expect((await cache.get(70_002))[0]!.provider).toBe("iq3");
  });

  it("local.stop ends -> onLocalChange fires before the job reads done", async () => {
    const home = mkdtempSync(join(tmpdir(), "pai-fresh-"));
    const seen: string[] = [];
    const deps = {
      home,
      ledger: join(home, "ledger.log"),
      tiers: ["big"],
      workersYaml: join(home, "none.yaml"),
      earlyMs: 5,
      stopModel: async () => void seen.push("stopped"),
      onLocalChange: () => void seen.push("change"),
    } as never;
    const r = await runCockpitAction({ action: "local.stop", target: "big" }, deps);
    await new Promise((res) => setTimeout(res, 50));
    expect(seen).toEqual(["stopped", "change"]);
    expect(readCockpitJob(home, r.jobId!)!.state).toBe("done");
    expect(readFileSync(join(home, "ledger.log"), "utf8")).toContain("done");
  });

  it("every local verb refreshes the limits and models feeds when it completes", () => {
    const m = /var WIN_VERBS=(\{[\s\S]*?\n\});/.exec(WIN_ACTIONS_JS);
    const verbs = new Function(`return ${m![1]}`)() as Record<string, { doneRefresh?: string[] }>;
    for (const v of ["local.start", "local.stop", "local.scale", "local.off"]) expect(verbs[v]!.doneRefresh).toEqual(["limits", "models"]);
    expect(PAGE_JS_FOR_TEST).toContain('f.indexOf("limits")>=0&&typeof loadLimits==="function")loadLimits()');
  });
});
