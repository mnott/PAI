import { describe, expect, it } from "vitest";
import { defaultLauncher, planStart } from "../../workers/local-tiers.js";
import { buildModelChoices, modelScreen, moveCursor, parseModelAnswer, resolveEnter } from "./model-pick.js";

const workers = {
  active: null,
  providers: {
    glm: { enabled: true, baseUrl: "https://api.example.com" },
    off: { enabled: false },
    ornith: { enabled: true, baseUrl: "http://127.0.0.1:8013" },
    local: { enabled: true, baseUrl: "http://127.0.0.1:8014" },
    ollama: { enabled: true, baseUrl: "http://localhost:11434", models: { default: "ollama-m" } },
  },
} as never;

const tier = (name: string, provider: string, port: number) => ({
  tier: name, provider, model: "m", served: `${name}-model`, port, flags: [],
});
const local = {
  tiers: { small: tier("small", "ornith", 8013), large: tier("large", "local", 8014) },
} as never;

describe("buildModelChoices", () => {
  it("default is first and carries no provider", () => {
    const c = buildModelChoices(workers, local, []);
    expect(c[0].provider).toBeUndefined();
    expect(c[0].label).toContain("anthropic");
  });

  it("lists anthropic and enabled providers, tier providers only as tiers", () => {
    const c = buildModelChoices(workers, local, []);
    expect(c.map((x) => x.label.split(" ")[0] + (x.tier ? "*" : ""))).toEqual([
      "default", "anthropic", "glm", "ollama", "local*", "local*",
    ]);
    expect(c.filter((x) => x.tier).map((x) => x.provider)).toEqual(["ornith", "local"]);
  });

  it("marks which tier is up from the running ports", () => {
    const c = buildModelChoices(workers, local, [{ port: 8013, rssKb: 20 * 1048576 }]);
    expect(c.find((x) => x.tier === "small")?.up).toBe(true);
    expect(c.find((x) => x.tier === "large")?.up).toBe(false);
  });

  it("works without local tiers", () => {
    expect(buildModelChoices(workers, null, []).some((x) => x.tier)).toBe(false);
  });
});

describe("parseModelAnswer", () => {
  const c = buildModelChoices(workers, local, [{ port: 8013, rssKb: 20 * 1048576 }]);
  it("Enter keeps the default", () => expect(parseModelAnswer("", c)).toBe(c[0]));
  it("number and name select", () => {
    expect(parseModelAnswer("3", c)?.provider).toBe("glm");
    expect(parseModelAnswer("glm", c)?.provider).toBe("glm");
    expect(parseModelAnswer("small", c)?.tier).toBe("small");
    expect(parseModelAnswer("local large", c)?.tier).toBe("large");
  });
  it("rejects unknown", () => {
    expect(parseModelAnswer("99", c)).toBeNull();
    expect(parseModelAnswer("nope", c)).toBeNull();
  });
});

describe("modelScreen", () => {
  it("numbers every choice", () => {
    const c = buildModelChoices(workers, local, []);
    const text = modelScreen(c, "proj").join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("Model for proj");
    expect(text).toContain(" 1  ");
    expect(text).toContain("local small");
  });
});

const strip = (l: string[]) => l.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("local grouping and memory", () => {
  const probe = { diskBytes: () => 18.4 * 1073741824 };
  it("groups cloud and local by base URL", () => {
    const c = buildModelChoices(workers, local, [], probe);
    expect(c.filter((x) => x.local).map((x) => x.provider)).toEqual(["ollama", "ornith", "local"]);
    const t = strip(modelScreen(c, "p"));
    expect(t.indexOf("CLOUD")).toBeLessThan(t.indexOf("glm"));
    expect(t.indexOf("glm")).toBeLessThan(t.indexOf("LOCAL"));
    expect(t.indexOf("LOCAL")).toBeLessThan(t.indexOf("local small"));
  });
  it("down non-tier local provider with its model on disk starts on demand", () => {
    const c = buildModelChoices(workers, local, [], { ...probe, findModel: () => "/m/ollama" });
    const o = c.find((x) => x.provider === "ollama")!;
    expect(o.missing).toBeUndefined();
    expect(o.launch).toMatchObject({ provider: "ollama", model: "/m/ollama", port: 11434, served: "ollama-m" });
    expect(o.mem).toBe("~18.4 GB");
    expect(parseModelAnswer("ollama", c)).toBe(o);
    const cfg = { launcher: defaultLauncher(), tiers: {} };
    const plan = planStart(cfg, o.launch!);
    expect(plan.argv.slice(2, 4)).toEqual(["serve", "/m/ollama"]);
    expect(plan.argv[plan.argv.indexOf("--port") + 1]).toBe("11434");
    expect(strip(modelScreen(c, "p"))).toContain("down — will be started");
  });
  it("model not on disk is dim not installed and cannot be chosen", () => {
    const c = buildModelChoices(workers, local, [], { ...probe, findModel: () => null });
    const o = c.find((x) => x.provider === "ollama")!;
    expect(o.missing).toBe(true);
    expect(parseModelAnswer("ollama", c)).toBeNull();
    expect(parseModelAnswer(String(c.indexOf(o) + 1), c)).toBeNull();
    expect(c[moveCursor(c, 2, 1)].provider).toBe("ornith");
    expect(strip(modelScreen(c, "p"))).toContain("not installed");
    expect(buildModelChoices(workers, local, [], { upPorts: [11434] }).find((x) => x.provider === "ollama")?.missing).toBeUndefined();
  });
  it("up tier shows RSS, down tier shows disk size and stays choosable", () => {
    const c = buildModelChoices(workers, local, [{ port: 8013, rssKb: 20 * 1048576 }], probe);
    expect(c.find((x) => x.tier === "small")?.mem).toBe("20.0 GB");
    expect(c.find((x) => x.tier === "large")?.mem).toBe("~18.4 GB");
    const t = strip(modelScreen(c, "p"));
    expect(t).toContain("20.0 GB RSS");
    expect(t).toContain("disk ~18.4 GB");
    expect(parseModelAnswer("large", c)?.tier).toBe("large");
  });
  it("arrow selection equals the number", () => {
    const c = buildModelChoices(workers, local, [], probe);
    const idx = c.findIndex((x) => x.tier === "large");
    expect(resolveEnter(c, idx, "")).toBe(parseModelAnswer(String(idx + 1), c));
    expect(resolveEnter(c, 0, "")).toBe(c[0]);
    expect(moveCursor(c, 0, -1)).toBe(0);
  });
});
