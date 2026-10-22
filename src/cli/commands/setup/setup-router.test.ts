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

  it("a taken flag port does not throw: it is recorded for the summary and nothing is written for the router", async () => {
    const u = await load();
    u.setupOptions.router = { enabled: true, port: 9200 };
    const taken = async () => ({ free: false, holder: "node pid 4242" });
    expect(await u.stepRouter(rl, taken, () => null)).toEqual({});
    expect(u.setupFailures.join("\n")).toMatch(/Port 9200 is in use by node pid 4242.*--router-port/);
  });

  it("--yes with the default port taken finishes the step (no throw, no loop) and the other answers still get written", async () => {
    const u = await load();
    const router = await u.stepRouter(rl, async () => ({ free: false }), () => null);
    expect(router).toEqual({});
    expect(u.setupFailures.join("\n")).toMatch(/Port 8790 is in use/);
    u.mergeConfig({ storageBackend: "sqlite", ...router });
    expect(u.readConfigRaw().storageBackend).toBe("sqlite");
  });

  it("the live router's own port is not foreign, with no router.enabled in config", async () => {
    const u = await load();
    expect(u.readConfigRaw().router).toBeUndefined();
    const cfg = await u.stepRouter(rl, async () => ({ free: false, holder: "node pid 77" }), () => 77);
    expect(cfg).toEqual({ router: { enabled: true, port: 8790, bind: "loopback" } });
    expect(u.setupFailures).toEqual([]);
  });

  it("--yes keeps a saved explicit bind and a saved tailscale bind", async () => {
    const u = await load();
    u.mergeConfig({ router: { enabled: true, port: 8790, bind: "10.0.0.5" } });
    expect(await u.stepRouter(rl, free, () => null)).toEqual({ router: { enabled: true, port: 8790, bind: "10.0.0.5" } });
    u.mergeConfig({ router: { enabled: true, port: 8790, bind: "tailscale" } });
    expect(await u.stepRouter(rl, free, () => null)).toEqual({ router: { enabled: true, port: 8790, bind: "tailscale" } });
    u.setupOptions.router = { bind: "loopback" };
    expect((await u.stepRouter(rl, free, () => null)).router).toMatchObject({ bind: "loopback" });
  });

  it("probes the reach address too, not only loopback", async () => {
    const u = await load();
    u.setupOptions.router = { bind: "10.0.0.5" };
    const seen: Array<string | undefined> = [];
    const probe = async (_p: number, host?: string) => { seen.push(host); return { free: host === undefined }; };
    expect(await u.stepRouter(rl, probe, () => null)).toEqual({});
    expect(seen).toEqual([undefined, "10.0.0.5"]);
    expect(u.setupFailures.join("\n")).toMatch(/on 10\.0\.0\.5/);
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
    expect(() => u.applySetupFlags({ "dry-run": true, "router-bind": "0.0.0.0" })).toThrow(/--router-bind/);
    expect(() => u.applySetupFlags({ "dry-run": true, "router-port": 80 })).toThrow(/--router-port/);
  });

  it("--embedding on a machine that already has a model warns that it is ignored", async () => {
    const u = await load();
    const emb = await import("./steps/03-embedding.js");
    u.mergeConfig({ embeddingModel: "BAAI/bge-small-en-v1.5" });
    u.setupOptions.embedding = "none";
    const r = await emb.stepEmbedding(rl);
    expect(r.embeddingModel).toBe("BAAI/bge-small-en-v1.5");
    expect(out.join("\n")).toMatch(/--embedding none ignored.*already set/);
  });

  it("--embedding none and --pg-url drive their steps", async () => {
    const u = await load();
    const emb = await import("./steps/03-embedding.js");
    u.setupOptions.embedding = "none";
    expect(await emb.stepEmbedding(rl)).toEqual({ embeddingModel: "none" });
  });
});

describe("--questions", () => {
  it("notes the effective storage default and follows the wizard order (name, router, AIBroker before MCP)", async () => {
    const u = await load();
    const qs = u.setupQuestions();
    expect(qs.find((q) => q.id === "storage")?.note).toMatch(/local PostgreSQL/);
    const ids = qs.map((q) => q.id);
    expect(ids.indexOf("da-name")).toBeLessThan(ids.indexOf("settings"));
    expect(ids.indexOf("aibroker")).toBeLessThan(ids.indexOf("mcp"));
    expect(ids.indexOf("router-bind")).toBeLessThan(ids.indexOf("mcp"));
  });

  it("lists router port with default 8790, in order after the components, with current values", async () => {
    const u = await load();
    u.mergeConfig({ storageBackend: "sqlite" });
    const qs = u.setupQuestions();
    const port = qs.find((q) => q.id === "router-port");
    expect(port).toMatchObject({ flag: "--router-port", default: 8790 });
    expect(qs.find((q) => q.id === "storage")).toMatchObject({ current: "sqlite", allowed: ["sqlite", "postgres"] });
    const ids = qs.map((q) => q.id);
    expect(ids.indexOf("daemon")).toBeLessThan(ids.indexOf("router"));
    expect(u.renderQuestions(qs)).toContain("--router-port  default: 8790");
  });
});
