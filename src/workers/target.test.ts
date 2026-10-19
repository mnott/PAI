import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkersConfig } from "./config.js";
import type { PortCheck } from "./local-provider.js";
import { resolveTarget, type TargetDeps } from "./target.js";

const prov = (baseUrl: string, models: { default: string; fast?: string }, enabled = true) => ({
  enabled,
  protocol: "anthropic" as const,
  baseUrl,
  keyFile: null,
  env: {},
  models,
});

const workers = {
  active: "glm",
  providers: {
    glm: prov("https://glm.example.invalid", { default: "glm-big", fast: "glm-small" }),
    kimi: prov("https://kimi.example.invalid", { default: "k3" }),
    flash: prov("http://127.0.0.1:8035", { default: "flash-m" }),
    idle: prov("http://127.0.0.1:8021", { default: "x" }),
    off: prov("https://off.example.invalid", { default: "o" }, false),
  },
} as unknown as TargetDeps["workers"];

const up: PortCheck = async (_h, port) => port === 8035;
const none: PortCheck = async () => false;
const deps = (over: Partial<TargetDeps> = {}): TargetDeps => ({
  workers,
  logDir: mkdtempSync(join(tmpdir(), "target-")),
  check: up,
  env: {},
  ...over,
});

describe("resolveTarget", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("cloud follows the detected session (transcript model), not workers.yaml active", async () => {
    const home = mkdtempSync(join(tmpdir(), "target-home-"));
    mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "p", "sess-1.jsonl"), JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" } }) + "\n");
    vi.stubEnv("HOME", home);
    const t = await resolveTarget({ where: "cloud" }, deps({ env: { CLAUDE_CODE_SESSION_ID: "sess-1" } }));
    expect(t).toMatchObject({ provider: "anthropic", model: "sonnet", description: "cloud: anthropic sonnet" });
  });
  it("local, one server up: it, described by name", async () => {
    const t = await resolveTarget({ where: "local" }, deps());
    expect(t).toMatchObject({ provider: "flash", description: "local: flash" });
  });
  it("worker_model fast: the provider's fast model unless the request says default or names one", async () => {
    const w = { ...workers, providers: { ...workers.providers, glm: { ...workers.providers.glm, workerModel: "fast" } } } as unknown as TargetDeps["workers"];
    expect(await resolveTarget({ where: "glm" }, deps({ workers: w }))).toMatchObject({ provider: "glm", model: "glm-small" });
    expect(await resolveTarget({ where: "glm", model: "default" }, deps({ workers: w }))).toMatchObject({ model: "glm-big" });
    expect(await resolveTarget({ where: "glm", model: "x-1" }, deps({ workers: w }))).toMatchObject({ model: "x-1" });
    expect(await resolveTarget({ model: "default" }, deps({ workers: w }))).toMatchObject({ modelDefault: true });
  });
  it("local, none up: the no-local-server error", async () => {
    await expect(resolveTarget({ where: "local" }, deps({ check: none }))).rejects.toThrow(/no local model server/);
  });
  it("cloud under anthropic: anthropic default", async () => {
    const t = await resolveTarget({ where: "cloud" }, deps({ workers: { ...workers, active: "auto" } as TargetDeps["workers"], env: { PAI_SESSION_PROVIDER: "anthropic" } }));
    expect(t).toMatchObject({ provider: "anthropic", model: "sonnet", description: "cloud: anthropic sonnet" });
  });
  it("cloud under a glm session: glm default; fast -> glm fast", async () => {
    const env = { PAI_SESSION_PROVIDER: "glm" };
    expect(await resolveTarget({ where: "cloud" }, deps({ env }))).toMatchObject({ provider: "glm", model: "glm-big" });
    expect(await resolveTarget({ where: "cloud", model: "fast" }, deps({ env }))).toMatchObject({ provider: "glm", model: "glm-small", description: "cloud: glm glm-small" });
  });
  it("cloud skips a loopback session provider and falls to active, then anthropic", async () => {
    expect((await resolveTarget({ where: "cloud" }, deps({ env: { PAI_SESSION_PROVIDER: "flash" } }))).provider).toBe("glm");
    const noActive = { ...workers, active: "flash" } as TargetDeps["workers"];
    expect((await resolveTarget({ where: "cloud" }, deps({ workers: noActive }))).provider).toBe("anthropic");
  });
  it("a named provider; an explicit model id wins; fast without a fast model uses default", async () => {
    expect(await resolveTarget({ where: "kimi" }, deps())).toMatchObject({ provider: "kimi", model: "k3", description: "kimi k3" });
    expect(await resolveTarget({ where: "kimi", model: "fast" }, deps())).toMatchObject({ model: "k3" });
    expect(await resolveTarget({ where: "glm", model: "glm-x" }, deps())).toMatchObject({ model: "glm-x" });
  });
  it("an unknown or disabled provider lists the valid names and which are running", async () => {
    const e = await resolveTarget({ where: "nope" }, deps()).catch((x) => x);
    expect(e.message).toContain('"nope"');
    expect(e.hint).toContain("flash (running)");
    expect(e.hint).toContain("idle (not running)");
    expect(e.hint).toContain("kimi");
    expect(e.hint).not.toMatch(/off\b/);
    await expect(resolveTarget({ where: "off" }, deps())).rejects.toThrow(/disabled/);
  });
  it("now sets front priority; omitted where leaves routing alone", async () => {
    expect((await resolveTarget({ where: "kimi", now: true }, deps())).priority).toBe("front");
    const t = await resolveTarget({ now: true, model: "fast" }, deps());
    expect(t.provider).toBeUndefined();
    expect(t).toMatchObject({ priority: "front", modelFast: true });
    const none = await resolveTarget({}, deps());
    expect([none.provider, none.model, none.priority]).toEqual([undefined, undefined, undefined]);
  });
});
