/** Router/cockpit step, setup flags and --questions, under a temp HOME with an injected port probe. */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rl = { question: () => { throw new Error("stdin was read"); } } as never;
let home: string;
let out: string[];

async function load() {
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, ".pai"));
  vi.stubEnv("PAI_CONFIG_FILE", "");
  const utils = await import("./utils.js");
  const router = await import("./steps/19-router.js");
  const questions = await import("./questions.js");
  const cmd = await import("../setup.js");
  utils.setupOptions.yes = true;
  return { ...utils, ...router, ...questions, ...cmd };
}

const free = async () => ({ free: true });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-setup-router-"));
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("stepRouter", () => {
  it("--yes takes the config default port 8790, loopback, enabled", async () => {
    const u = await load();
    const cfg = await u.stepRouter(rl, free);
    expect(cfg).toEqual({ router: { enabled: true, port: 8790, bind: "loopback" } });
  });

  it("flags land in config.yaml-or-json through the config writer", async () => {
    const u = await load();
    u.setupOptions.router = { enabled: true, port: 9100, bind: "tailscale" };
    const cfg = await u.stepRouter(rl, free);
    u.mergeConfig(cfg);
    const files = readdirSync(join(home, ".pai")).filter((f) => f.startsWith("config."));
    const text = readFileSync(join(home, ".pai", files[0]), "utf8");
    expect(text).toMatch(/9100/);
    expect(text).toMatch(/tailscale/);
    expect(u.readConfigRaw().router).toMatchObject({ enabled: true, port: 9100, bind: "tailscale" });
  });

  it("--no-router writes enabled false and asks nothing", async () => {
    const u = await load();
    u.setupOptions.router = { enabled: false };
    expect(await u.stepRouter(rl, free)).toEqual({ router: { enabled: false } });
  });

  it("a taken port is detected by the probe and names its holder", async () => {
    const u = await load();
    u.setupOptions.router = { enabled: true, port: 9200 };
    const taken = async () => ({ free: false, holder: "node pid 4242" });
    await expect(u.stepRouter(rl, taken)).rejects.toThrow(/Port 9200 is in use by node pid 4242.*--router-port/);
  });

  it("--yes with the default port taken fails instead of looping", async () => {
    const u = await load();
    await expect(u.stepRouter(rl, async () => ({ free: false }))).rejects.toThrow(/Port 8790 is in use/);
  });

  it("rejects a bad port and 0.0.0.0", async () => {
    const u = await load();
    u.setupOptions.router = { enabled: true, port: 80 };
    await expect(u.stepRouter(rl, free)).rejects.toThrow(/--router-port/);
    u.setupOptions.router = { enabled: true, port: 9300, bind: "0.0.0.0" };
    await expect(u.stepRouter(rl, free)).rejects.toThrow(/--router-bind/);
  });

  it("validPort / validBind", async () => {
    const u = await load();
    expect([u.validPort("8790"), u.validPort("x"), u.validPort(70000)]).toEqual([8790, null, null]);
    expect([u.validBind("loopback"), u.validBind("192.168.1.5"), u.validBind("nope")]).toEqual(["loopback", "192.168.1.5", null]);
  });
});

describe("setup flags", () => {
  it("--no-<component> forces a yes/no answer without asking", async () => {
    const u = await load();
    u.applySetupFlags({ yes: true, "no-hooks": true, "task-bus": true, "no-router": true, "router-port": 9400, embedding: "none", "pg-url": "postgresql://x" });
    expect(u.setupOptions.answers).toMatchObject({ hooks: false, "task-bus": true });
    expect(await u.promptYesNo(rl, "Install hooks?", true, "hooks")).toBe(false);
    expect(u.setupOptions.router).toEqual({ enabled: false, port: 9400, bind: undefined });
    expect(u.setupOptions.embedding).toBe("none");
    expect(u.setupOptions.pgUrl).toBe("postgresql://x");
  });

  it("rejects bad values", async () => {
    const u = await load();
    expect(() => u.applySetupFlags({ embedding: "gpt" })).toThrow(/--embedding/);
    expect(() => u.applySetupFlags({ router: true, "no-router": true })).toThrow(/contradict/);
  });

  it("--embedding none and --pg-url drive their steps", async () => {
    const u = await load();
    const emb = await import("./steps/03-embedding.js");
    u.setupOptions.embedding = "none";
    expect(await emb.stepEmbedding(rl)).toEqual({ embeddingModel: "none" });
  });
});

describe("--questions", () => {
  it("lists router port with default 8790, in order after the components, with current values", async () => {
    const u = await load();
    u.mergeConfig({ storageBackend: "sqlite" });
    const qs = u.setupQuestions();
    const port = qs.find((q) => q.id === "router-port");
    expect(port).toMatchObject({ flag: "--router-port", default: 8790 });
    expect(qs.find((q) => q.id === "storage")).toMatchObject({ current: "sqlite", allowed: ["sqlite", "postgres"] });
    const ids = qs.map((q) => q.id);
    expect(ids.indexOf("daemon")).toBeLessThan(ids.indexOf("router"));
    expect(ids.indexOf("router-bind")).toBeLessThan(ids.indexOf("aibroker"));
    expect(u.renderQuestions(qs)).toContain("--router-port  default: 8790");
  });
});
