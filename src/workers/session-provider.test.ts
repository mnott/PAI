import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig } from "./config.js";
import { resolveTarget } from "./routing.js";
import { applySessionProviderEnv, providerForModel } from "./session-provider.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pai-session-provider-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function config() {
  return parseWorkersConfig({
    enabled: true,
    active: "glm",
    providers: {
      glm: {
        baseUrl: "https://api.example.com/api/anthropic",
        keyFile: "~/.config/example/api_key",
        models: { default: "glm-5.3", fast: "glm-5.3-flash" },
        env: {},
      },
    },
    classes: { implement: "glm/fast", spotcheck: "glm/fast" },
  });
}

/** classes pinned to nothing, so the class map cannot decide */
function openConfig() {
  const c = config();
  c.classes = {};
  return c;
}

function transcript(sessionId: string, model: string | null): void {
  const dir = join(tmp, ".claude", "projects", "-some-project");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    ...(model ? [JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [] } })] : []),
    JSON.stringify({ type: "user", message: { role: "user", content: "again" } }),
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

const base = () => ({ sessionEnv: {} as NodeJS.ProcessEnv, home: tmp, cwd: tmp });

describe("session provider routing", () => {
  it("env provider: default model for implement, fast for spotcheck/simple", () => {
    const env = { PAI_SESSION_PROVIDER: "anthropic" };
    const impl = resolveTarget(openConfig(), tmp, { ...base(), sessionEnv: env, className: "implement" });
    expect([impl.providerName, impl.modelAlias, impl.via]).toEqual(["anthropic", "default", "session"]);
    expect(impl.routeWhy).toBe("session: launched on anthropic");
    for (const cls of ["spotcheck", "simple"]) {
      const t = resolveTarget(openConfig(), tmp, { ...base(), sessionEnv: env, className: cls });
      expect([t.providerName, t.modelAlias]).toEqual(["anthropic", "fast"]);
    }
  });

  it("env provider ignores the class map's provider", () => {
    const t = resolveTarget(config(), tmp, {
      ...base(),
      sessionEnv: { PAI_SESSION_PROVIDER: "anthropic" },
      className: "implement",
    });
    expect([t.providerName, t.modelAlias, t.via]).toEqual(["anthropic", "default", "session"]);
  });

  it("unset env + parent transcript on claude-opus-5-5 -> anthropic", () => {
    transcript("sess-a", "claude-opus-5-5");
    const t = resolveTarget(openConfig(), tmp, {
      ...base(),
      sessionEnv: { CLAUDE_CODE_SESSION_ID: "sess-a" },
      className: "implement",
    });
    expect([t.providerName, t.via]).toEqual(["anthropic", "session"]);
    expect(t.routeWhy).toBe("session: parent model claude-opus-5-5");
  });

  it("unset env + parent transcript on glm-5.3 -> glm", () => {
    transcript("sess-b", "glm-5.3[1m]");
    const cfg = openConfig();
    cfg.active = null;
    const t = resolveTarget(cfg, tmp, {
      ...base(),
      sessionEnv: { CLAUDE_CODE_SESSION_ID: "sess-b" },
      className: "spotcheck",
    });
    expect([t.providerName, t.modelAlias, t.via]).toEqual(["glm", "fast", "session"]);
  });

  it("unset env and no transcript -> config active", () => {
    const t = resolveTarget(openConfig(), tmp, {
      ...base(),
      sessionEnv: { CLAUDE_CODE_SESSION_ID: "missing" },
      className: "implement",
    });
    expect([t.providerName, t.via]).toEqual(["glm", "active"]);
    expect(t.routeWhy).toBe("config: active glm");
  });

  it("a transcript with an unknown model falls to the budget chain, not config", () => {
    transcript("sess-c", "mystery-1");
    const t = resolveTarget(openConfig(), tmp, { ...base(), sessionEnv: { CLAUDE_CODE_SESSION_ID: "sess-c" } });
    expect(t.via).toBe("active");
  });

  it("an explicit --provider beats env and transcript", () => {
    transcript("sess-d", "claude-opus-5-5");
    const t = resolveTarget(openConfig(), tmp, {
      ...base(),
      sessionEnv: { PAI_SESSION_PROVIDER: "anthropic", CLAUDE_CODE_SESSION_ID: "sess-d" },
      flagProvider: "glm",
      className: "implement",
    });
    expect([t.providerName, t.via]).toEqual(["glm", "flag"]);
  });

  it("a session provider in cooldown falls to the budget chain, not config", () => {
    const state = { cooldowns: { anthropic: new Date(Date.now() + 600_000).toISOString() } };
    mkdirSync(join(tmp, "x"), { recursive: true });
    writeFileSync(join(tmp, "routing-state.json"), JSON.stringify(state));
    const t = resolveTarget(openConfig(), tmp, { ...base(), sessionEnv: { PAI_SESSION_PROVIDER: "anthropic" } });
    expect(t.providerName).not.toBe("anthropic");
    expect(t.routeWhy).toContain("anthropic cooling down ->");
  });
});

describe("providerForModel", () => {
  it("claude-* is anthropic, others match a provider's models", () => {
    const c = config();
    expect(providerForModel(c, "claude-opus-5-5")).toBe("anthropic");
    expect(providerForModel(c, "glm-5.3-flash")).toBe("glm");
    expect(providerForModel(c, "nope")).toBeNull();
  });
});

describe("applySessionProviderEnv", () => {
  it("a followed session exports the provider to children", () => {
    const env: NodeJS.ProcessEnv = {};
    applySessionProviderEnv(env, { via: "session", providerName: "glm" });
    expect(env.PAI_SESSION_PROVIDER).toBe("glm");
  });

  it("an explicit --provider run does not pass it on", () => {
    const env: NodeJS.ProcessEnv = { PAI_SESSION_PROVIDER: "anthropic" };
    applySessionProviderEnv(env, { via: "flag", providerName: "glm" });
    expect(env.PAI_SESSION_PROVIDER).toBeUndefined();
  });
});
