/**
 * Tests for the spawn environment: a headless worker must not inherit the
 * spawner's session identity (messaging socket, session id, nesting markers)
 * — inherited, a worktree-mode child starts with its core tools deferred out
 * of reach and only the tool-registry search callable (2026-09-18).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunEnv } from "./run-env.js";
import type { WorkerProvider } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "pai-runenv-test-"));
const keyFile = join(dir, "key");
let provider: WorkerProvider;

beforeAll(() => {
  writeFileSync(keyFile, "test-token\n", "utf8");
  provider = {
    baseUrl: "https://api.example.invalid/api/anthropic",
    keyFile,
    models: { default: "example-5.3", fast: "example-5.3-flash" },
    env: {},
  } as WorkerProvider;
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
