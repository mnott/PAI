import { describe, expect, it } from "vitest";
import { NATIVE_ANTHROPIC_MODELS, type WorkerProvider, type WorkersConfig } from "../../workers/config.js";
import { buildLaunchPlan } from "../../workers/launch.js";
import { buildHarness, execLine, nameArgs } from "./harness.js";

const provider = (o: Partial<WorkerProvider>): WorkerProvider => ({
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://api.example.invalid/anthropic",
  keyFile: null,
  key: "test-key-1234567890",
  models: { default: "example-default" },
  env: {},
  ...o,
});

const workers: Pick<WorkersConfig, "providers" | "nativeModels" | "logDir"> = {
  logDir: "/nonexistent-pai-test-logs",
  nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
  providers: {
    alpha: provider({ models: { default: "alpha-1", fast: "alpha-fast" } }),
    beta: provider({ baseUrl: "https://beta.example.invalid/", key: "beta-key-abcdefghij", models: { default: "beta-1" } }),
  },
};

describe("buildHarness", () => {
  it("builds the same argv and env as the shared launch plan, with name args appended", async () => {
    const plan = await buildLaunchPlan(workers, "alpha", undefined, nameArgs("demo"), "/nonexistent-pai-test-logs");
    const h = await buildHarness(workers, { provider: "alpha", cwd: "/tmp/x", name: "demo" });
    expect(h.argv).toEqual(plan.argv);
    expect(h.env).toEqual(plan.env);
    expect(h.cmd).toBe("claude");
    expect(h.model).toBe("alpha-1");
  });

  it("puts --resume before --name and pins the provider route and model", async () => {
    const h = await buildHarness(workers, { provider: "beta", cwd: "/tmp/x", name: "demo", resume: "uuid-1" });
    const i = h.argv.indexOf("--resume");
    expect(h.argv.slice(i)).toEqual(["--resume", "uuid-1", "--name", "demo", "/Name demo"]);
    expect(h.argv).toContain("--model");
    expect(h.argv[h.argv.indexOf("--model") + 1]).toBe("beta-1");
    expect(h.env.ANTHROPIC_BASE_URL).toBe("https://beta.example.invalid/");
    expect(h.env.PAI_WORKER).toBeUndefined();
  });

  it("honours an explicit model of that provider and rejects one it does not have", async () => {
    const h = await buildHarness(workers, { provider: "alpha", model: "alpha-fast", cwd: "/tmp/x", name: "n" });
    expect(h.model).toBe("alpha-fast");
    await expect(buildHarness(workers, { provider: "alpha", model: "nope", cwd: "/tmp/x", name: "n" })).rejects.toThrow(/not configured/);
  });

  it("fails for an unknown provider and names the configured ones", async () => {
    await expect(buildHarness(workers, { provider: "gamma", cwd: "/tmp/x", name: "n" })).rejects.toThrow(/alpha/);
  });
});

describe("execLine (dry-run)", () => {
  it("never prints the auth token, including inside the --settings JSON", async () => {
    const h = await buildHarness(workers, { provider: "beta", cwd: "/tmp/x y", name: "demo" });
    const line = execLine(h);
    expect(line).not.toContain("beta-key-abcdefghij");
    expect(line).toContain("****ghij");
    expect(line.startsWith('cd "/tmp/x y" && claude ')).toBe(true);
  });
});
