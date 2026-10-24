import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig } from "./config.js";
import {
  POLICY_MODES,
  chooseRoute,
  clearPolicy,
  committedFallThrough,
  fallThroughReason,
  findLocal,
  parseDuration,
  readPolicy,
  writePolicy,
  type PolicyMode,
  type RouteInputs,
} from "./policy.js";

const base = (o: Partial<RouteInputs>): RouteInputs => ({
  mode: "auto",
  urgent: false,
  localOk: false,
  cloud: false,
  battery: false,
  local: "local30",
  localWhy: "local down",
  cloudUnavailable: false,
  ...o,
});
const route = (o: Partial<RouteInputs>) => {
  const c = chooseRoute(base(o));
  return c.local ? `local:${c.reason}` : `cloud:${c.reason}`;
};

describe("chooseRoute table", () => {
  // [mode, urgent, battery, localUp] -> route
  const rows: Array<[PolicyMode, boolean, boolean, boolean, string]> = [
    ["cloud-only", false, false, true, "cloud:policy cloud-only"],
    ["cloud-only", true, true, false, "cloud:policy cloud-only"],
    ["local-only", false, false, true, "local:policy local-only"],
    ["local-only", true, true, true, "local:policy local-only"],
    ["prefer-local", false, false, true, "local:policy prefer-local"],
    ["prefer-local", false, true, true, "local:policy prefer-local"],
    ["prefer-local", true, false, true, "cloud:urgent"],
    ["prefer-local", false, false, false, "cloud:local down"],
    ["prefer-cloud", false, false, true, "cloud:policy prefer-cloud"],
    ["prefer-cloud", true, true, false, "cloud:policy prefer-cloud"],
    ["auto", false, false, true, "local:policy auto"],
    ["auto", false, true, true, "cloud:battery"],
    ["auto", true, false, true, "cloud:urgent"],
    ["auto", true, true, true, "cloud:battery"],
    ["auto", false, false, false, "cloud:local down"],
  ];
  for (const [mode, urgent, battery, up, want] of rows) {
    it(`${mode} urgent=${urgent} battery=${battery} local ${up ? "up" : "down"} -> ${want}`, () => {
      expect(route({ mode, urgent, battery, local: up ? "local30" : null })).toBe(want);
    });
  }

  it("covers every mode", () => {
    expect(new Set(rows.map((r) => r[0]))).toEqual(new Set(POLICY_MODES));
  });

  it("local-only fails when nothing answers", () => {
    expect(() => chooseRoute(base({ mode: "local-only", local: null }))).toThrow(/local-only: local down/);
  });
  it("no local provider reads as such", () => {
    expect(route({ mode: "prefer-local", local: null, localWhy: "no local provider" })).toBe("cloud:no local provider");
  });
  it("--cloud sends prefer-local to the cloud, --local-ok sends prefer-cloud local", () => {
    expect(route({ mode: "prefer-local", cloud: true })).toBe("cloud:--cloud");
    expect(route({ mode: "prefer-cloud", localOk: true })).toBe("local:--local-ok");
    expect(route({ mode: "prefer-cloud", localOk: true, local: null })).toBe("cloud:policy prefer-cloud");
  });
  it("prefer-cloud goes local when the cloud is unavailable", () => {
    expect(route({ mode: "prefer-cloud", cloudUnavailable: true })).toBe("local:cloud unavailable");
    expect(route({ mode: "prefer-cloud", cloudUnavailable: true, local: null })).toBe("cloud:policy prefer-cloud");
  });
});

describe("policy store", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-policy-"));
  it("round-trips, expires and clears", () => {
    expect(readPolicy(dir)).toBeNull();
    const t0 = new Date("2026-10-14T20:00:00Z");
    writePolicy(dir, "cloud-only", parseDuration("2h"), t0);
    expect(readPolicy(dir, new Date("2026-10-14T21:59:00Z"))?.mode).toBe("cloud-only");
    expect(readPolicy(dir, new Date("2026-10-14T22:01:00Z"))).toBeNull();
    writePolicy(dir, "auto");
    expect(readPolicy(dir)?.until).toBeUndefined();
    clearPolicy(dir);
    expect(readPolicy(dir)).toBeNull();
  });
  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(() => parseDuration("soon")).toThrow(/--for/);
  });
});

describe("findLocal", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-policy-local-"));
  const prov = (url: string, enabled = true) => ({
    enabled,
    baseUrl: url,
    keyFile: "~/k",
    models: { default: "m" },
    env: {},
  });
  const cfg = (providers: Record<string, unknown>) => parseWorkersConfig({ enabled: true, active: null, providers });
  it("none configured -> no local provider", async () => {
    expect(await findLocal(cfg({ glm: prov("https://api.example.com") }), dir, async () => true)).toEqual({
      name: null,
      why: "no local provider",
    });
  });
  it("disabled local is ignored", async () => {
    const r = await findLocal(cfg({ a: prov("http://127.0.0.1:8011", false) }), dir, async () => true);
    expect(r.why).toBe("no local provider");
  });
  it("first answering local wins, none answering -> local down", async () => {
    const c = cfg({ a: prov("http://127.0.0.1:8011"), b: prov("http://localhost:8012") });
    expect((await findLocal(c, dir, async (u) => u.includes("8012"))).name).toBe("b");
    expect(await findLocal(c, dir, async () => false)).toEqual({ name: null, why: "local down" });
  });
});

describe("fallThroughReason", () => {
  const local = { policy: "prefer-local" as const, reason: "policy prefer-local", local: true };
  it("a benchmark-labelled run never falls through; unlabelled is unchanged", () => {
    const bad = { reportValid: false, rc: 0 };
    expect(fallThroughReason(local, bad, { result: "-" }, "hold probe3 bench")).toBeNull();
    expect(fallThroughReason(local, bad, { result: "-" }, "refactor the parser")).toBe("invalid report");
    expect(fallThroughReason(local, bad, { result: "-" })).toBe("invalid report");
  });
  it("good report stays", () => {
    expect(fallThroughReason(local, { reportValid: true, state: "done", rc: 0 }, { result: "+" })).toBeNull();
    expect(fallThroughReason(local, { state: "done", rc: 0 }, { result: "~" })).toBeNull();
  });
  it("invalid / downgraded report falls through", () => {
    expect(fallThroughReason(local, { reportValid: false, rc: 0 }, { result: "~" })).toBe("invalid report");
  });
  it("r=- and r=! fall through", () => {
    expect(fallThroughReason(local, { rc: 0 }, { result: "-" })).toBe("r=-");
    expect(fallThroughReason(local, { rc: 0 }, { result: "!" })).toBe("r=!");
  });
  it("max-minutes falls through, even though the kill is rc 143", () => {
    expect(fallThroughReason(local, { timedOut: true, rc: 143 }, { result: "~" })).toBe("max-minutes");
  });
  it("an operator kill does not", () => {
    expect(fallThroughReason(local, { rc: 143, state: "failed" }, null)).toBeNull();
  });
  it("crash without a report falls through", () => {
    expect(fallThroughReason(local, { rc: 1, state: "failed" }, null)).toBe("no report");
  });
  it("never from local-only, cloud runs, or runs without a route", () => {
    const bad = { reportValid: false, rc: 0 };
    expect(fallThroughReason({ ...local, policy: "local-only" }, bad, { result: "-" })).toBeNull();
    expect(fallThroughReason({ ...local, local: false }, bad, { result: "-" })).toBeNull();
    expect(fallThroughReason(undefined, bad, { result: "-" })).toBeNull();
  });
});

describe("committedFallThrough", () => {
  it("bad report + commits -> r=~ with the commits, no cloud re-run", () => {
    const r = committedFallThrough("invalid report", ["abc1234 fix(x): y"]);
    expect(r?.result).toBe("~");
    expect(r?.why).toBe("local run committed but its report was invalid: invalid report");
    expect(r?.notes).toContain("commits: abc1234 fix(x): y");
  });
  it("bad report, no commits -> null, the cloud re-run goes ahead", () => {
    expect(committedFallThrough("invalid report", [])).toBeNull();
  });
  it("no fall-through reason -> null", () => {
    expect(committedFallThrough(null, ["abc1234 x"])).toBeNull();
  });
});
