import { describe, expect, it } from "vitest";
import { buildModelChoices, modelScreen, parseModelAnswer } from "./model-pick.js";

const workers = {
  active: null,
  providers: {
    glm: { enabled: true },
    off: { enabled: false },
    ornith: { enabled: true },
    local: { enabled: true },
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
      "default", "anthropic", "glm", "local*", "local*",
    ]);
    expect(c.filter((x) => x.tier).map((x) => x.provider)).toEqual(["ornith", "local"]);
  });

  it("marks which tier is up from the running ports", () => {
    const c = buildModelChoices(workers, local, [{ port: 8013 }]);
    expect(c.find((x) => x.tier === "small")?.up).toBe(true);
    expect(c.find((x) => x.tier === "large")?.up).toBe(false);
  });

  it("works without local tiers", () => {
    expect(buildModelChoices(workers, null, []).some((x) => x.tier)).toBe(false);
  });
});

describe("parseModelAnswer", () => {
  const c = buildModelChoices(workers, local, [{ port: 8013 }]);
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
