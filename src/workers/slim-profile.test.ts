import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nativeAnthropicProvider, type WorkerProvider } from "./config.js";
import { pinnedSettings } from "./run-env.js";
import { poolSlotSettingsId, slimProfileArgs, slimSettings } from "./slim-profile.js";

const USER = {
  env: { A: "1" },
  permissions: { allow: ["Bash"] },
  enabledPlugins: { x: true },
  outputStyle: "Concise",
  hooks: {
    SessionStart: [{ hooks: [{ command: "${PAI_DIR}/Hooks/load-core-context.mjs" }] }],
    UserPromptSubmit: [{ hooks: [{ command: "${PAI_DIR}/Hooks/whisper-rules.mjs" }] }],
    PreToolUse: [
      { hooks: [{ command: "${PAI_DIR}/Hooks/security-validator.mjs" }, { command: "node x/aibroker-progress.mjs" }] },
      { hooks: [{ command: "node ${PAI_DIR}/Hooks/ab-levers.mjs pre" }] },
    ],
  },
};

describe("slim worker profile", () => {
  it("keeps env, permissions and guard hooks only", () => {
    const s = slimSettings(USER) as any;
    expect(s.env).toEqual({ A: "1" });
    expect(s.permissions).toEqual({ allow: ["Bash"] });
    expect(s.enabledPlugins).toBeUndefined();
    expect(s.outputStyle).toBeUndefined();
    expect(Object.keys(s.hooks)).toEqual(["PreToolUse"]);
    expect(s.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(s.hooks.PreToolUse[1].hooks[0].command).toContain("ab-levers");
  });

  it("writes the file and drops the user source; opt-outs yield no args", () => {
    const dir = mkdtempSync(join(tmpdir(), "slim-"));
    const user = join(dir, "settings.json");
    writeFileSync(user, JSON.stringify(USER));
    const args = slimProfileArgs(dir, "w1", [], {}, user);
    expect(args.slice(0, 2)).toEqual(["--setting-sources", "project,local"]);
    expect(JSON.parse(readFileSync(args[3], "utf8")).hooks.PreToolUse).toBeDefined();
    expect(slimProfileArgs(dir, "w1", [], { PAI_WORKER_FULL_PROFILE: "1" }, user)).toEqual([]);
    expect(slimProfileArgs(dir, "w1", ["--settings", "x"], {}, user)).toEqual([]);
    expect(slimProfileArgs(dir, "w1", [], {}, join(dir, "missing.json"))).toEqual([]);
  });
});

describe("slimProfileArgs route pin", () => {
  it("carries the route pin inside the file: Claude Code keeps only the last --settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "slim-"));
    const user = join(dir, "settings.json");
    writeFileSync(user, JSON.stringify({ ...USER, env: { KEEP: "1", ANTHROPIC_BASE_URL: "http://user-proxy" } }));
    const pin = pinnedSettings({}, true);
    const file = JSON.parse(readFileSync(slimProfileArgs(dir, "w2", [], {}, user, undefined, pin)[3]!, "utf8"));
    expect(file.env.ANTHROPIC_BASE_URL).toBe(pin.env.ANTHROPIC_BASE_URL);
    expect(file.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(file.env.KEEP).toBe("1");
    expect(file.hooks.PreToolUse).toBeDefined();
  });
});

describe("slimSettings provider env", () => {
  it("drops the user's endpoint and token keys when the provider sets them", () => {
    const user = { env: { A: "1", ANTHROPIC_BASE_URL: "u", ANTHROPIC_AUTH_TOKEN: "t" } };
    const s = slimSettings(user, { ANTHROPIC_BASE_URL: "local", ANTHROPIC_AUTH_TOKEN: "x" }) as any;
    expect(s.env).toEqual({ A: "1" });
    expect((slimSettings(user, {}) as any).env.ANTHROPIC_BASE_URL).toBe("u");
  });
});

describe("slimSettings attribution", () => {
  it("switches commit and PR attribution off", () => {
    expect((slimSettings({}) as any).attribution).toEqual({ commit: "", pr: "" });
  });
});

describe("slimSettings non-anthropic provider", () => {
  const user = {
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", A: "1" },
  };
  const local = (extra: Partial<WorkerProvider> = {}): WorkerProvider => ({
    enabled: true,
    protocol: "anthropic",
    baseUrl: "http://127.0.0.1:1",
    keyFile: null,
    models: { default: "m" },
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192" },
    ...extra,
  });

  it("takes the provider's output cap, drops the first-party flag, disables thinking", () => {
    const s = slimSettings(user, {}, local()) as any;
    expect(s.env).toEqual({
      A: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
      CLAUDE_CODE_DISABLE_THINKING: "1",
      CLAUDE_CODE_EFFORT_LEVEL: "unset",
    });
  });

  it("drops the user's cap when the provider sets none, and works without a user env", () => {
    expect((slimSettings(user, {}, local({ env: {} })) as any).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect((slimSettings({}, {}, local()) as any).env.CLAUDE_CODE_DISABLE_THINKING).toBe("1");
  });

  it("leaves thinking alone with thinking: on", () => {
    const e = (slimSettings(user, {}, local({ thinking: true })) as any).env;
    expect(e.CLAUDE_CODE_DISABLE_THINKING).toBeUndefined();
    expect(e.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(e.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
  });

  it("anthropic (native or no provider) is unchanged", () => {
    expect((slimSettings(user) as any).env).toEqual(user.env);
    expect((slimSettings(user, {}, nativeAnthropicProvider()) as any).env).toEqual(user.env);
  });
});

describe("slim profile note hook", () => {
  const local = { ...nativeAnthropicProvider(), native: false, baseUrl: "http://127.0.0.1:1", env: {} } as WorkerProvider;

  it("adds the note PostToolUse hook for native and local providers, once even if the user has one", () => {
    const user = { hooks: { PostToolUse: [{ matcher: "*", hooks: [{ command: "x/worker-note.mjs" }] }] } };
    for (const p of [undefined, local]) {
      const s = slimSettings(user, {}, p, 'node "/d/hooks/worker-note.mjs" "/logs"') as any;
      expect(s.hooks.PostToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: 'node "/d/hooks/worker-note.mjs" "/logs"' }] }]);
    }
  });

  it("adds none without a hook command", () => {
    expect((slimSettings(USER) as any).hooks.PostToolUse).toBeUndefined();
  });
});

describe("pool slot settings", () => {
  it("gives each provider/model its own file carrying its provider env", () => {
    const dir = mkdtempSync(join(tmpdir(), "slim-"));
    const user = join(dir, "settings.json");
    writeFileSync(user, JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" } }));
    const local = { ...nativeAnthropicProvider(), native: false, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192" } } as WorkerProvider;
    const env = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_ENTRYPOINT: "cli" };
    const a = slimProfileArgs(dir, poolSlotSettingsId("codernext4", "qwen/3"), [], env, user, local);
    const b = slimProfileArgs(dir, poolSlotSettingsId("anthropic", "haiku"), [], env, user, nativeAnthropicProvider());
    expect(a[3]).not.toBe(b[3]);
    const sa = JSON.parse(readFileSync(a[3], "utf8")).env;
    expect(sa.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
    expect(sa.CLAUDE_CODE_DISABLE_THINKING).toBe("1");
    expect(JSON.parse(readFileSync(b[3], "utf8")).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
  });
});
