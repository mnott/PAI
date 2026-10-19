import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The down/disabled local-provider guard (incident 2026-10-19: `pai worker
 * run --provider local30 …` although nothing listened on local30's port; the
 * worker sat at "starting" for minutes). A named provider that is loopback
 * must be enabled and answer the HTTP models probe — the same probe
 * resolveLocalProvider uses — or the run is refused at once, naming the
 * running local provider and the fix (--local). The probe is injected;
 * nothing here waits on a port.
 */

const root = mkdtempSync(join(tmpdir(), "pai-localguard-"));
const home = join(root, "home");
const logDir = join(root, "logs", "workers");

// CONFIG_FILE is a module-level constant, evaluated on first import of
// daemon/config.ts: pin it at the temp config before anything pulls it in.
process.env.PAI_CONFIG_FILE = join(home, "config.yaml");
process.env.PAI_WORKERS_YAML = join(home, "workers.yaml");

const { runWorker, LocalProviderRefusedError, assertLocalProviderAlive } = await import("./run.js");
const { LOCAL_MECHANISM_LINE } = await import("./local-provider.js");
const { describeProviders } = await import("./providers.js");
const { parseWorkersConfig, NATIVE_ANTHROPIC_MODELS } = await import("./config.js");

const yaml = [
  "providers:",
  "  glm:",
  "    url: https://glm.example.invalid",
  "    models:",
  "      default: glm-big",
  "  dead30:",
  "    url: http://127.0.0.1:45993",
  "    models:",
  "      default: flash-dead",
  "  off30:",
  "    url: http://127.0.0.1:45994",
  "    enabled: false",
  "    models:",
  "      default: flash-off",
  "  up30:",
  "    url: http://127.0.0.1:45995",
  "    models:",
  "      default: flash-up",
  "  glmoff:",
  "    url: https://glm-off.example.invalid",
  "    enabled: false",
  "    models:",
  "      default: glm-off",
  "",
].join("\n");

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(home, "config.yaml"), `workers:\n  enabled: true\n  logDir: ${logDir}\n`);
  writeFileSync(join(home, "workers.yaml"), yaml);
}, 10_000);

afterAll(() => {
  delete process.env.PAI_CONFIG_FILE;
  delete process.env.PAI_WORKERS_YAML;
  try {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(process.cwd(), ".pai-scratch", `localguard-${process.pid}`), { recursive: true, force: true });
  } catch {
    // best effort
  }
});

/** Only port 45995 answers; the probe records its calls. */
const calls: Array<[string, number]> = [];
const only45995 = async (host: string, port: number): Promise<boolean> => {
  calls.push([host, port]);
  return port === 45995;
};

const cfg = parseWorkersConfig({
  enabled: true,
  providers: {
    glm: { baseUrl: "https://glm.example.invalid", models: { default: "glm-big" } },
    dead30: { baseUrl: "http://127.0.0.1:45993", models: { default: "flash-dead" } },
    off30: { baseUrl: "http://127.0.0.1:45994", enabled: false, models: { default: "flash-off" } },
    up30: { baseUrl: "http://127.0.0.1:45995", models: { default: "flash-up" } },
    glmoff: { baseUrl: "https://glm-off.example.invalid", enabled: false, models: { default: "glm-off" } },
  },
});

describe("assertLocalProviderAlive", () => {
  it("an enabled loopback provider whose probe fails: refused, naming the running one and --local", async () => {
    calls.length = 0;
    await expect(
      assertLocalProviderAlive(cfg, logDir, "dead30", cfg.providers.dead30, { _localCheck: only45995 })
    ).rejects.toThrow(LocalProviderRefusedError);
    try {
      await assertLocalProviderAlive(cfg, logDir, "dead30", cfg.providers.dead30, { _localCheck: only45995 });
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('provider "dead30"');
      expect(m).toContain("127.0.0.1:45993");
      expect(m).toContain("not running");
      expect(m).toContain("Running local provider: up30");
      expect(m).toContain(LOCAL_MECHANISM_LINE);
    }
    // the probe used is the models probe, on the provider's own port
    expect(calls).toContainEqual(["127.0.0.1", 45993]);
  });

  it("an explicit disabled loopback provider: refused the same way", async () => {
    await expect(
      assertLocalProviderAlive(cfg, logDir, "off30", cfg.providers.off30, { _localCheck: only45995 })
    ).rejects.toThrow(/provider "off30" is a local \(loopback\) provider and is disabled[\s\S]*Running local provider: up30/);
  });

  it("a loopback provider whose server answers: passes (the run spawns)", async () => {
    await expect(
      assertLocalProviderAlive(cfg, logDir, "up30", cfg.providers.up30, { _localCheck: only45995 })
    ).resolves.toBeUndefined();
  });

  it("remote providers are unaffected, enabled or disabled", async () => {
    await expect(
      assertLocalProviderAlive(cfg, logDir, "glm", cfg.providers.glm, { _localCheck: async () => false })
    ).resolves.toBeUndefined();
  });

  it("a run already resolved by --local is not probed twice", async () => {
    await expect(
      assertLocalProviderAlive(cfg, logDir, "dead30", cfg.providers.dead30, {
        localFlag: true,
        _localCheck: async () => {
          throw new Error("must not probe");
        },
      })
    ).resolves.toBeUndefined();
  });
});

describe("runWorker: a named local provider that is down or disabled", () => {
  it("--provider on a dead loopback provider: refused before any spawn", async () => {
    await expect(
      runWorker({
        providerFlag: "dead30",
        printCmd: true,
        quiet: true,
        claudeArgs: ["-p", "x"],
        _localCheck: only45995,
      })
    ).rejects.toThrow(/provider "dead30"[\s\S]*use --local/);
  });

  it("--provider on a disabled loopback provider: refused, with the --local line", async () => {
    await expect(
      runWorker({
        providerFlag: "off30",
        printCmd: true,
        quiet: true,
        claudeArgs: ["-p", "x"],
        _localCheck: only45995,
      })
    ).rejects.toThrow(/provider "off30" is disabled[\s\S]*use --local/);
  });

  it("--provider on a disabled REMOTE provider: refused too, without the --local line", async () => {
    await expect(
      assertLocalProviderAlive(cfg, logDir, "glmoff", cfg.providers.glmoff, { _localCheck: async () => false })
    ).resolves.toBeUndefined(); // the local guard itself: remote untouched
    await expect(
      runWorker({
        providerFlag: "glmoff",
        printCmd: true,
        quiet: true,
        claudeArgs: ["-p", "x"],
        _localCheck: async () => false,
      })
    ).rejects.toThrow(/provider "glmoff" is disabled(?![\s\S]*--local)/);
  });

  it("--provider on a running loopback provider: the dry run prints its argv", async () => {
    const log = console.log;
    let out = "";
    console.log = (s?: unknown) => {
      out += String(s);
    };
    try {
      const rc = await runWorker({
        providerFlag: "up30",
        printCmd: true,
        quiet: true,
        claudeArgs: ["-p", "x"],
        _localCheck: only45995,
      });
      expect(rc).toBe(0);
      expect(JSON.parse(out).route).toBe("up30/flash-up (flag: --provider)");
    } finally {
      console.log = log;
    }
  });

  it("--provider on a remote provider: untouched by the guard", async () => {
    const log = console.log;
    let out = "";
    console.log = (s?: unknown) => {
      out += String(s);
    };
    try {
      const rc = await runWorker({
        providerFlag: "glm",
        printCmd: true,
        quiet: true,
        claudeArgs: ["-p", "x"],
        _localCheck: async () => false,
      });
      expect(rc).toBe(0);
      expect(JSON.parse(out).route).toBe("glm/glm-big (flag: --provider)");
    } finally {
      console.log = log;
    }
  });
});

describe("the --local line in the listings", () => {
  it("describeProviders starts with it", () => {
    const lines = describeProviders({ ...cfg, nativeModels: { ...NATIVE_ANTHROPIC_MODELS } }, join(home, "config.yaml"));
    expect(lines[0]).toBe(LOCAL_MECHANISM_LINE);
  });
});
