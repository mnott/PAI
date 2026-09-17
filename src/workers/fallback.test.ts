/**
 * Tests for the machine-wide Claude Code fallback.
 *
 * `on` must switch settings.json (env block + model pin) and remember what it
 * replaced; `off` must give the original file back byte for byte. A restore
 * that is merely "equivalent JSON" is not enough — the settings file belongs
 * to Claude Code, not to us.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackOn, fallbackOff, fallbackStatus, fallbackEnv } from "./fallback.js";
import { parseWorkersConfig } from "./config.js";

let dir: string;
let settingsPath: string;
let configPath: string;
let logDir: string;
let keyPath: string;

const SETTINGS = {
  model: "opus",
  env: {
    ANTHROPIC_BASE_URL: "https://old.example.com",
    UNRELATED: "keep-me",
  },
  permissions: { allow: ["Bash(ls:*)"] },
};

function writeFixtures(): void {
  writeFileSync(settingsPath, JSON.stringify(SETTINGS, null, 2) + "\n", "utf8");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workers: {
          enabled: true,
          active: "glm",
          providers: {
            glm: {
              baseUrl: "https://api.example.com/api/anthropic",
              keyFile: keyPath,
              models: { default: "example-4.7", fast: "example-4.7-flash" },
              env: { API_TIMEOUT_MS: "3000000" },
            },
          },
          logDir,
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-fallback-"));
  settingsPath = join(dir, "settings.json");
  configPath = join(dir, "config.json");
  logDir = join(dir, "logs");
  mkdirSync(logDir, { recursive: true });
  keyPath = join(dir, "api_key");
  writeFileSync(keyPath, "test-token\n", "utf8");
  writeFixtures();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const paths = () => ({ settingsPath, configPath });

describe("fallback on", () => {
  it("writes the provider env and model pin into settings.json", () => {
    const r = fallbackOn(undefined, paths());
    expect(r.alreadyOn).toBe(false);
    expect(r.provider).toBe("glm");
    expect(r.model).toBe("example-4.7");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(s.env.ANTHROPIC_BASE_URL).toBe("https://api.example.com/api/anthropic");
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
    expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("example-4.7");
    expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("example-4.7");
    expect(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("example-4.7-flash");
    expect(s.env.API_TIMEOUT_MS).toBe("3000000");
    expect(s.env.ENABLE_TOOL_SEARCH).toBe("true");
    expect(s.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(s.env.UNRELATED).toBe("keep-me");
    expect(s.model).toBe("example-4.7");
    expect(s.permissions).toEqual(SETTINGS.permissions);
  });

  it("saves the replaced values under workers.fallback.saved", () => {
    fallbackOn(undefined, paths());
    const c = parseWorkersConfig(
      JSON.parse(readFileSync(configPath, "utf8")).workers
    );
    expect(c.fallback?.provider).toBe("glm");
    expect(c.fallback?.saved.model).toBe("opus");
    expect(c.fallback?.saved.envExisted).toBe(true);
    expect(c.fallback?.saved.env.ANTHROPIC_BASE_URL).toBe("https://old.example.com");
    expect(c.fallback?.saved.env.ANTHROPIC_AUTH_TOKEN).toBeNull();
  });

  it("leaves the FALLBACK-ACTIVE note in the log dir", () => {
    fallbackOn(undefined, paths());
    const note = readFileSync(join(logDir, "FALLBACK-ACTIVE.md"), "utf8");
    expect(note).toContain("provider: glm");
    expect(note).toContain("pai worker fallback off");
  });
});

describe("fallback off", () => {
  it("restores settings.json byte for byte", () => {
    const before = readFileSync(settingsPath, "utf8");
    fallbackOn(undefined, paths());
    expect(readFileSync(settingsPath, "utf8")).not.toBe(before);
    fallbackOff(paths());
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });

  it("clears the switch and the note", () => {
    fallbackOn(undefined, paths());
    fallbackOff(paths());
    const c = parseWorkersConfig(
      JSON.parse(readFileSync(configPath, "utf8")).workers
    );
    expect(c.fallback).toBeNull();
    expect(() => readFileSync(join(logDir, "FALLBACK-ACTIVE.md"), "utf8")).toThrow();
  });

  it("refuses when not on", () => {
    expect(() => fallbackOff(paths())).toThrow(/not on/);
  });

  it("restores exactly when settings had no env block and no model", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n", "utf8");
    const before = readFileSync(settingsPath, "utf8");
    fallbackOn(undefined, paths());
    fallbackOff(paths());
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });
});

describe("idempotent on", () => {
  it("re-applies without changing the file or the saved state", () => {
    fallbackOn(undefined, paths());
    const settingsAfter1 = readFileSync(settingsPath, "utf8");
    const configAfter1 = readFileSync(configPath, "utf8");
    const r = fallbackOn(undefined, paths());
    expect(r.alreadyOn).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsAfter1);
    expect(readFileSync(configPath, "utf8")).toBe(configAfter1);
  });

  it("switching providers while on keeps the restore exact", () => {
    const before = readFileSync(settingsPath, "utf8");
    fallbackOn(undefined, paths());
    // a second provider, pinned explicitly
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.workers.providers.other = {
      baseUrl: "https://other.example.com",
      keyFile: keyPath,
      models: { default: "other-1" },
      env: {},
    };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    fallbackOn("other", paths());
    fallbackOff(paths());
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });
});

describe("fallbackStatus", () => {
  it("reports off, then on with provider and note path", () => {
    expect(fallbackStatus(paths()).on).toBe(false);
    fallbackOn(undefined, paths());
    const s = fallbackStatus(paths());
    expect(s.on).toBe(true);
    expect(s.provider).toBe("glm");
    expect(s.notePath).toBe(join(logDir, "FALLBACK-ACTIVE.md"));
  });
});

describe("fallbackEnv", () => {
  it("maps fast model to haiku, default to sonnet and opus", () => {
    const workers = parseWorkersConfig(
      JSON.parse(readFileSync(configPath, "utf8")).workers
    );
    const env = fallbackEnv(workers.providers.glm);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("example-4.7-flash");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("example-4.7");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("example-4.7");
  });

  it("uses the local placeholder token for providers without a key file", () => {
    const env = fallbackEnv({
      enabled: true,
      protocol: "anthropic",
      baseUrl: "http://localhost:1",
      keyFile: null,
      models: { default: "m" },
      env: {},
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("local");
  });
});
