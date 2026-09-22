/**
 * Tests for the spawn environment: a headless worker must not inherit the
 * spawner's session identity (messaging socket, session id, nesting markers)
 * nor the spawner's harness settings — ENABLE_TOOL_SEARCH arrives through the
 * user settings' env block and, inherited, leaves the child with only the
 * tool-registry search callable (2026-09-18).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildRunEnv, claudeCommand } from "./run-env.js";
import { nativeAnthropicProvider, type WorkerProvider } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "pai-runenv-test-"));
const keyFile = join(dir, "key");
let provider: WorkerProvider;

beforeAll(() => {
  writeFileSync(keyFile, "test-token\n", "utf8");
  provider = {
    enabled: true,
    protocol: "anthropic",
    baseUrl: "https://api.example.invalid/api/anthropic",
    keyFile,
    models: { default: "example-5.3", fast: "example-5.3-flash" },
    env: {},
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the vars a spawning Claude Code session leaves in its Bash children
const SESSION_IDENTITY = [
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
  "CLAUDECODE",
];

describe("buildRunEnv session identity", () => {
  it("strips the spawner's session identity from a headless run", () => {
    const saved = { ...process.env };
    for (const k of SESSION_IDENTITY) process.env[k] = "spawner-value";
    process.env.ANTHROPIC_API_KEY = "must-not-cross";
    try {
      const env = buildRunEnv(provider, true);
      for (const k of [...SESSION_IDENTITY, "ANTHROPIC_API_KEY"]) {
        expect(env[k], `${k} must be stripped`).toBeUndefined();
      }
      expect(env.ANTHROPIC_BASE_URL).toBe(provider.baseUrl);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
      expect(env.PAI_WORKER).toBe("1");
    } finally {
      for (const k of [...SESSION_IDENTITY, "ANTHROPIC_API_KEY"]) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    }
  });

  it("strips an inherited ENABLE_TOOL_SEARCH from a headless run", () => {
    const saved = { ...process.env };
    // the user settings' env block injects this into every claude process,
    // so a pai spawned from a session's Bash carries it into worker children
    process.env.ENABLE_TOOL_SEARCH = "true";
    try {
      const env = buildRunEnv(provider, true);
      expect(env.ENABLE_TOOL_SEARCH, "core tools must not be deferred away").toBeUndefined();
    } finally {
      if (saved.ENABLE_TOOL_SEARCH === undefined) delete process.env.ENABLE_TOOL_SEARCH;
      else process.env.ENABLE_TOOL_SEARCH = saved.ENABLE_TOOL_SEARCH;
    }
  });

  it("keeps the caller's own environment for an interactive run", () => {
    const saved = { ...process.env };
    process.env.CLAUDECODE = "1";
    delete process.env.PAI_WORKER; // this test may itself run inside a worker
    try {
      const env = buildRunEnv(provider, false);
      expect(env.CLAUDECODE).toBe("1");
      expect(env.ENABLE_TOOL_SEARCH).toBe("true");
      expect(env.PAI_WORKER).toBeUndefined();
    } finally {
      if (saved.CLAUDECODE === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved.CLAUDECODE;
      if (saved.PAI_WORKER !== undefined) process.env.PAI_WORKER = saved.PAI_WORKER;
    }
  });
});

describe("buildRunEnv native anthropic", () => {
  it("strips ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY even when the parent shell has them set", () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = "https://leaked.example.invalid/api/anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "leaked-token";
    process.env.ANTHROPIC_API_KEY = "leaked-key";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "leaked-model";
    try {
      const env = buildRunEnv(nativeAnthropicProvider(), true);
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(env.PAI_WORKER).toBe("1");
    } finally {
      for (const k of [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
      ]) {
        delete process.env[k];
      }
      for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    }
  });
});

describe("claudeCommand", () => {
  it("pins a set route again with --settings regardless of caveman", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9911/glm" };
    for (const caveman of [true, false]) {
      const cmd = claudeCommand(env, caveman);
      expect(cmd[0]).toBe("claude");
      expect(cmd[1]).toBe("--settings");
      const parsed = JSON.parse(cmd[2]);
      expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9911/glm");
    }
  });

  it("routes through `caveman claude` when caveman is on and it is on PATH", () => {
    const binDir = mkdtempSync(join(tmpdir(), "pai-caveman-bin-"));
    const binPath = join(binDir, "caveman");
    writeFileSync(binPath, "#!/bin/sh\n", "utf8");
    chmodSync(binPath, 0o755);
    try {
      const env: NodeJS.ProcessEnv = { PATH: [binDir, process.env.PATH ?? ""].join(delimiter) };
      expect(claudeCommand(env, true)).toEqual(["caveman", "claude"]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("pins to api.anthropic.com when there is no route and caveman is off", () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
    const cmd = claudeCommand(env, false);
    expect(cmd[0]).toBe("claude");
    expect(cmd[1]).toBe("--settings");
    const parsed = JSON.parse(cmd[2]);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });
});
