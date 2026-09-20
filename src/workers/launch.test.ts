/**
 * Tests for launch.ts — the `pai launch` provider/model table, resolution
 * and env-plan builder. Fixture is a plain WorkersConfig-shaped object
 * (three providers: one enabled anthropic-protocol, one disabled, one
 * openai-protocol) — this is the input readWorkersSection() would hand
 * these functions, so no YAML/JSON round-trip is needed to exercise them.
 */

import { describe, it, expect } from "vitest";
import { NATIVE_ANTHROPIC_MODELS, type WorkerProvider, type WorkersConfig } from "./config.js";
import { buildRunEnv } from "./run-env.js";
import {
  LaunchError,
  buildLaunchPlan,
  buildLaunchRows,
  detectCurrentModel,
  detectCurrentProviderName,
  launchableProviderNames,
  maskLaunchEnv,
  resolveLaunchModel,
  resolveLaunchProvider,
} from "./launch.js";

function provider(overrides: Partial<WorkerProvider>): WorkerProvider {
  return {
    enabled: true,
    protocol: "anthropic",
    baseUrl: "https://api.example.invalid/api/anthropic",
    keyFile: null,
    key: "test-key-0000",
    models: { default: "example-default" },
    env: {},
    ...overrides,
  };
}

/** enabled glm (anthropic-protocol), disabled kimi, enabled together (openai-protocol) */
const fixture: Pick<WorkersConfig, "active" | "providers" | "nativeModels"> = {
  active: "glm",
  nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
  providers: {
    glm: provider({
      baseUrl: "https://api.z.ai/api/anthropic",
      models: { default: "glm-5.3[1m]", fast: "glm-5.3-flash" },
    }),
    kimi: provider({ enabled: false, baseUrl: "https://api.kimi.ai/coding/", models: { default: "k3[1m]" } }),
    together: provider({
      protocol: "openai",
      baseUrl: "",
      upstreamUrl: "https://api.together.xyz/v1",
      models: { default: "together-default" },
    }),
  },
};

describe("buildLaunchRows", () => {
  it("lists exactly the enabled providers/models and nothing else", () => {
    const rows = buildLaunchRows(fixture);
    const pairs = rows.map((r) => `${r.provider}/${r.model}`);

    // built-in anthropic (always present) + default/fast of both enabled providers
    expect(pairs).toEqual([
      `anthropic/${NATIVE_ANTHROPIC_MODELS.default}`,
      `anthropic/${NATIVE_ANTHROPIC_MODELS.fast}`,
      "glm/glm-5.3[1m]",
      "glm/glm-5.3-flash",
      "together/together-default",
    ]);
    // the disabled provider (kimi) must not appear at all
    expect(rows.some((r) => r.provider === "kimi")).toBe(false);
  });

  it("numbers rows sequentially starting at 1", () => {
    const rows = buildLaunchRows(fixture);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("marks the configured active provider, not any other", () => {
    const rows = buildLaunchRows(fixture);
    const glmRows = rows.filter((r) => r.provider === "glm");
    expect(glmRows.every((r) => r.configActive)).toBe(true);
    expect(rows.filter((r) => r.provider !== "glm").every((r) => !r.configActive)).toBe(true);
  });

  it("built-in anthropic is marked active when nothing else is configured active", () => {
    const rows = buildLaunchRows({ ...fixture, active: null });
    const anthropicRows = rows.filter((r) => r.provider === "anthropic");
    expect(anthropicRows.every((r) => r.configActive)).toBe(true);
  });
});

describe("launchableProviderNames", () => {
  it("includes the built-in provider and every enabled provider, excludes disabled ones", () => {
    expect(launchableProviderNames(fixture)).toEqual(["anthropic", "glm", "together"]);
  });
});

describe("resolveLaunchProvider", () => {
  it("resolves the built-in anthropic provider", () => {
    const p = resolveLaunchProvider(fixture, "anthropic");
    expect(p.native).toBe(true);
  });

  it("resolves an enabled configured provider", () => {
    const p = resolveLaunchProvider(fixture, "glm");
    expect(p.baseUrl).toBe("https://api.z.ai/api/anthropic");
  });

  it("throws LaunchError naming the valid providers for an unknown name", () => {
    expect(() => resolveLaunchProvider(fixture, "nope")).toThrow(LaunchError);
    try {
      resolveLaunchProvider(fixture, "nope");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LaunchError);
      expect((e as Error).message).toContain("anthropic, glm, together");
    }
  });

  it("throws LaunchError for a disabled provider, naming the valid ones", () => {
    try {
      resolveLaunchProvider(fixture, "kimi");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LaunchError);
      expect((e as Error).message).toContain("disabled");
      expect((e as Error).message).toContain("anthropic, glm, together");
    }
  });
});

describe("resolveLaunchModel", () => {
  it("defaults to the provider's default model", () => {
    const p = resolveLaunchProvider(fixture, "glm");
    expect(resolveLaunchModel(p)).toBe("glm-5.3[1m]");
  });

  it("accepts a configured non-default model id", () => {
    const p = resolveLaunchProvider(fixture, "glm");
    expect(resolveLaunchModel(p, "glm-5.3-flash")).toBe("glm-5.3-flash");
  });

  it("rejects an unconfigured model id, naming the valid ones", () => {
    const p = resolveLaunchProvider(fixture, "glm");
    try {
      resolveLaunchModel(p, "not-a-real-model");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LaunchError);
      expect((e as Error).message).toContain("glm-5.3[1m]");
      expect((e as Error).message).toContain("glm-5.3-flash");
    }
  });
});

describe("detectCurrentProviderName", () => {
  it("matches an anthropic-protocol provider's exact base URL", () => {
    expect(detectCurrentProviderName(fixture, { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" })).toBe("glm");
  });

  it("matches an openai-protocol provider via the local proxy URL suffix", () => {
    expect(
      detectCurrentProviderName(fixture, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8797/together" })
    ).toBe("together");
  });

  it("falls back to the built-in provider when no ANTHROPIC_BASE_URL is set", () => {
    expect(detectCurrentProviderName(fixture, {})).toBe("anthropic");
  });

  it("falls back to the built-in provider for an unrecognized base URL", () => {
    expect(detectCurrentProviderName(fixture, { ANTHROPIC_BASE_URL: "https://unknown.invalid" })).toBe("anthropic");
  });
});

describe("detectCurrentModel", () => {
  it("reads ANTHROPIC_DEFAULT_SONNET_MODEL when set", () => {
    expect(detectCurrentModel({ ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3[1m]" })).toBe("glm-5.3[1m]");
  });

  it("returns null (not a guess) when unset", () => {
    expect(detectCurrentModel({})).toBeNull();
  });
});

describe("buildLaunchPlan — argv and env per provider shape", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const withLeakedKey = <T>(fn: () => T): T => {
    process.env.ANTHROPIC_API_KEY = "must-not-leak-to-a-child";
    try {
      return fn();
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  };

  it("anthropic (built-in): --model only, no base URL/token, no ANTHROPIC_API_KEY leak", async () => {
    const plan = await withLeakedKey(() => buildLaunchPlan(fixture, "anthropic", undefined, [], "/tmp/pai-launch-test"));
    expect(plan.argv).toEqual(["--model", NATIVE_ANTHROPIC_MODELS.default]);
    expect(plan.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("anthropic-protocol provider (glm-shape): base URL + auth token from the YAML, model passed through", async () => {
    const plan = await withLeakedKey(() =>
      buildLaunchPlan(fixture, "glm", "glm-5.3-flash", ["--resume", "abc"], "/tmp/pai-launch-test")
    );
    expect(plan.argv).toEqual(["--model", "glm-5.3-flash", "--resume", "abc"]);
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("test-key-0000");
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("openai-protocol provider (together-shape) via buildRunEnv directly: proxy URL, placeholder token, no key leak", () => {
    // Exercises the exact env shape buildLaunchPlan hands an openai-protocol
    // provider WITHOUT starting the real PAI proxy (ensureProxyRunning spawns
    // a detached background process on the shared default port — unsafe as a
    // unit-test side effect). buildRunEnv is the one env builder either path
    // goes through; this pins the shape it produces once a proxy URL exists.
    const together = fixture.providers.together;
    const env = withLeakedKey(() => buildRunEnv(together, false, "http://127.0.0.1:8797/together"));
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8797/together");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("local");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rejects an unknown provider before building any env", async () => {
    await expect(buildLaunchPlan(fixture, "nope", undefined, [], "/tmp/pai-launch-test")).rejects.toThrow(LaunchError);
  });

  it("never inherits the calling process's own PAI_WORKER marker — a launch is a new session, not a worker", async () => {
    const savedWorker = process.env.PAI_WORKER;
    const savedWorkerId = process.env.PAI_WORKER_ID;
    process.env.PAI_WORKER = "1";
    process.env.PAI_WORKER_ID = "some-ancestor-worker-id";
    try {
      const anthropicPlan = await buildLaunchPlan(fixture, "anthropic", undefined, [], "/tmp/pai-launch-test");
      expect(anthropicPlan.env.PAI_WORKER).toBeUndefined();
      expect(anthropicPlan.env.PAI_WORKER_ID).toBeUndefined();

      const glmPlan = await buildLaunchPlan(fixture, "glm", undefined, [], "/tmp/pai-launch-test");
      expect(glmPlan.env.PAI_WORKER).toBeUndefined();
      expect(glmPlan.env.PAI_WORKER_ID).toBeUndefined();
    } finally {
      if (savedWorker === undefined) delete process.env.PAI_WORKER;
      else process.env.PAI_WORKER = savedWorker;
      if (savedWorkerId === undefined) delete process.env.PAI_WORKER_ID;
      else process.env.PAI_WORKER_ID = savedWorkerId;
    }
  });
});

describe("maskLaunchEnv", () => {
  it("masks ANTHROPIC_AUTH_TOKEN to its last 4 characters", () => {
    const masked = maskLaunchEnv({ ANTHROPIC_AUTH_TOKEN: "sk-verysecret1234", ANTHROPIC_BASE_URL: "https://x" });
    expect(masked.ANTHROPIC_AUTH_TOKEN).toBe("****1234");
    expect(masked.ANTHROPIC_AUTH_TOKEN).not.toContain("verysecret");
    expect(masked.ANTHROPIC_BASE_URL).toBe("https://x");
  });

  it("leaves the local placeholder token unmasked", () => {
    const masked = maskLaunchEnv({ ANTHROPIC_AUTH_TOKEN: "local" });
    expect(masked.ANTHROPIC_AUTH_TOKEN).toBe("local");
  });
});
