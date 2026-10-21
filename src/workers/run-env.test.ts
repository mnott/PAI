/**
 * Tests for the spawn environment: a headless worker must not inherit the
 * spawner's session identity (messaging socket, session id, nesting markers)
 * nor the spawner's harness settings — ENABLE_TOOL_SEARCH arrives through the
 * user settings' env block and, inherited, leaves the child with only the
 * tool-registry search callable (2026-09-18).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildRunEnv, claudeCommand, nativeLaunchSettingsArgs, probeRoute, routeLoopbackViaRouter } from "./run-env.js";
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
    process.env.ANTHROPIC_API_KEY = "must-not-cross-example";
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

  it("starts a headless run without Claude Code auto-memory", () => {
    expect(buildRunEnv(provider, true).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(buildRunEnv(nativeAnthropicProvider(), true).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("keeps the caller's own environment for an interactive run", () => {
    const saved = { ...process.env };
    process.env.CLAUDECODE = "1";
    delete process.env.PAI_WORKER; // this test may itself run inside a worker
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY; // workers inherit it
    try {
      const env = buildRunEnv(provider, false);
      expect(env.CLAUDECODE).toBe("1");
      expect(env.ENABLE_TOOL_SEARCH).toBe("true");
      expect(env.PAI_WORKER).toBeUndefined();
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    } finally {
      if (saved.CLAUDECODE === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved.CLAUDECODE;
      if (saved.PAI_WORKER !== undefined) process.env.PAI_WORKER = saved.PAI_WORKER;
      if (saved.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== undefined) {
        process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = saved.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
      }
    }
  });
});

describe("buildRunEnv native anthropic", () => {
  it("strips ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY even when the parent shell has them set", () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = "https://leaked.example.invalid/api/anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "your-leaked-token";
    process.env.ANTHROPIC_API_KEY = "your-leaked-key";
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
  it("pins a set route again with --settings", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9911/glm" };
    const cmd = claudeCommand(env);
      expect(cmd[0]).toBe("claude");
      expect(cmd[1]).toBe("--settings");
      const parsed = JSON.parse(cmd[2]);
      expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9911/glm");
  });

  it("pins to api.anthropic.com when there is no route", () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
    const cmd = claudeCommand(env, false);
    expect(cmd[0]).toBe("claude");
    expect(cmd[1]).toBe("--settings");
    const parsed = JSON.parse(cmd[2]);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("pins a native run to the router when it is enabled", () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
    const parsed = JSON.parse(claudeCommand(env, true)[2]);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8790");
  });

  it("keeps a provider route and token when the router is enabled", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" };
    const parsed = JSON.parse(claudeCommand(env, true)[2]);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
  });
});

describe("buildRunEnv router route", () => {
  it("routes a provider run through the router when asked, keeps the direct route otherwise", () => {
    expect(buildRunEnv(provider, true, undefined, "local30", true).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8790");
    expect(buildRunEnv(provider, true, undefined, "local30", false).ANTHROPIC_BASE_URL).toBe(provider.baseUrl);
    // the openai-protocol proxy route wins over the router
    expect(buildRunEnv(provider, true, "http://127.0.0.1:9911/local30", "local30", true).ANTHROPIC_BASE_URL).toBe(
      "http://127.0.0.1:9911/local30"
    );
  });

  it("leaves the key to the router: no provider token pinned on the router route", () => {
    expect(buildRunEnv(provider, true, undefined, "local30", true).ANTHROPIC_AUTH_TOKEN).toBe("local");
    expect(buildRunEnv(provider, true, undefined, "local30", false).ANTHROPIC_AUTH_TOKEN).toBe("test-token");
  });
});

describe("buildRunEnv PAI_WORKER_PROVIDER", () => {
  it("names the provider for a headless worker, anthropic for the native one", () => {
    expect(buildRunEnv(provider, true, undefined, "local30").PAI_WORKER_PROVIDER).toBe("local30");
    expect(buildRunEnv(nativeAnthropicProvider(), true).PAI_WORKER_PROVIDER).toBe("anthropic");
  });

  it("is not set for an interactive run", () => {
    const saved = process.env.PAI_WORKER_PROVIDER;
    delete process.env.PAI_WORKER_PROVIDER;
    try {
      expect(buildRunEnv(provider, false, undefined, "local30").PAI_WORKER_PROVIDER).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.PAI_WORKER_PROVIDER = saved;
    }
  });
});

describe("local-provider worker prompt overhead", () => {
  const strip = ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"] as const;
  const saved = strip.map((k) => process.env[k]);
  beforeAll(() => strip.forEach((k) => delete process.env[k]));
  afterAll(() => strip.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]))));

  it("headless non-anthropic worker: CLAUDE.md and memory off, output style default", () => {
    const env = buildRunEnv(provider, true, undefined, "local30");
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(JSON.parse(claudeCommand(env, false)[2]).outputStyle).toBe("default");
  });

  it("anthropic worker and interactive runs are untouched", () => {
    for (const env of [buildRunEnv(nativeAnthropicProvider(), true), buildRunEnv(nativeAnthropicProvider(), false), buildRunEnv(provider, false, undefined, "local30")]) {
      expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined();
      expect(JSON.parse(claudeCommand(env, false)[2])).not.toHaveProperty("outputStyle");
    }
    // every headless worker has auto-memory off (main), interactive runs keep it
    expect(buildRunEnv(nativeAnthropicProvider(), true).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(buildRunEnv(nativeAnthropicProvider(), false).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });
});

describe("buildRunEnv client timeout", () => {
  const local = (): WorkerProvider => ({ ...provider, baseUrl: "http://127.0.0.1:8034" });
  // the request timeout plus Claude Code's two stream idle watchdogs (300 s
  // floor each): all three must clear a long silent local tool-call generation
  const TIMEOUT_VARS = [
    "API_TIMEOUT_MS",
    "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
    "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
  ];
  it("loopback provider gets all three timeouts at 30 min", () => {
    const env = buildRunEnv({ ...local(), env: {} }, true, undefined, "local30");
    for (const k of TIMEOUT_VARS) expect(env[k], k).toBe("1800000");
  });
  it("provider env wins over all three", () => {
    const env = buildRunEnv(
      { ...local(), env: { API_TIMEOUT_MS: "5", CLAUDE_STREAM_IDLE_TIMEOUT_MS: "6", CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "7" } },
      true,
      undefined,
      "local30"
    );
    expect(env.API_TIMEOUT_MS).toBe("5");
    expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("6");
    expect(env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("7");
  });
  it("remote provider is untouched", () => {
    const saved = process.env.API_TIMEOUT_MS;
    delete process.env.API_TIMEOUT_MS;
    const env = buildRunEnv(provider, true, undefined, "x");
    for (const k of TIMEOUT_VARS) expect(env[k], k).toBeUndefined();
    if (saved !== undefined) process.env.API_TIMEOUT_MS = saved;
  });
});

describe("routeLoopbackViaRouter", () => {
  const local = (extra: Partial<WorkerProvider> = {}): WorkerProvider => ({
    ...provider,
    baseUrl: "http://127.0.0.1:8034",
    ...extra,
  });

  it("routes a loopback provider through the router with the provider header", () => {
    const p = local();
    const via = routeLoopbackViaRouter(p, true);
    expect(via).toBe(true);
    const env = buildRunEnv(p, true, undefined, "local30x8", via);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8790");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-pai-provider: local30x8");
  });

  it("falls back to direct when the router is down", () => {
    expect(routeLoopbackViaRouter(local(), false)).toBe(false);
  });

  it("stays direct with router: false", () => {
    expect(routeLoopbackViaRouter(local({ router: false }), true)).toBe(false);
  });

  it("leaves remote and native providers alone", () => {
    expect(routeLoopbackViaRouter(provider, true)).toBe(false);
    expect(routeLoopbackViaRouter(nativeAnthropicProvider(), true)).toBe(false);
  });
});

describe("buildRunEnv orchestrator mode", () => {
  it("sets PAI_WORKER_ORCHESTRATOR=1 for non-native provider when orchestrate=true", () => {
    const env = buildRunEnv(provider, true, undefined, undefined, undefined, true);
    expect(env.PAI_WORKER_ORCHESTRATOR).toBe("1");
  });

  it("sets PAI_WORKER_ORCHESTRATOR=1 for native provider when orchestrate=true", () => {
    const env = buildRunEnv(nativeAnthropicProvider(), true, undefined, undefined, undefined, true);
    expect(env.PAI_WORKER_ORCHESTRATOR).toBe("1");
  });

  it("does not set PAI_WORKER_ORCHESTRATOR when orchestrate is not specified", () => {
    const env = buildRunEnv(provider, true);
    expect(env.PAI_WORKER_ORCHESTRATOR).toBeUndefined();
  });

  it("does not set PAI_WORKER_ORCHESTRATOR when orchestrate=false", () => {
    const env = buildRunEnv(provider, true, undefined, undefined, undefined, false);
    expect(env.PAI_WORKER_ORCHESTRATOR).toBeUndefined();
  });

  it("does not override existing PAI_WORKER_ORCHESTRATOR when set beforehand", () => {
    const saved = process.env.PAI_WORKER_ORCHESTRATOR;
    try {
      process.env.PAI_WORKER_ORCHESTRATOR = "1";
      const env = buildRunEnv(provider, true, undefined, undefined, undefined, false);
      expect(env.PAI_WORKER_ORCHESTRATOR).toBeUndefined();
    } finally {
      process.env.PAI_WORKER_ORCHESTRATOR = saved;
    }
  });
});

describe("buildRunEnv worker shell", () => {
  it("headless workers get CLAUDE_CODE_SHELL=/bin/bash, native and provider routes alike", () => {
    expect(buildRunEnv(provider, true).CLAUDE_CODE_SHELL).toBe("/bin/bash");
    expect(buildRunEnv(nativeAnthropicProvider(), true).CLAUDE_CODE_SHELL).toBe("/bin/bash");
  });

  it("an interactive run keeps the operator's shell", () => {
    const saved = process.env.CLAUDE_CODE_SHELL;
    delete process.env.CLAUDE_CODE_SHELL;
    try {
      expect(buildRunEnv(provider, false).CLAUDE_CODE_SHELL).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CODE_SHELL = saved;
    }
  });

  it("an explicit CLAUDE_CODE_SHELL wins", () => {
    const saved = process.env.CLAUDE_CODE_SHELL;
    process.env.CLAUDE_CODE_SHELL = "/bin/sh";
    try {
      expect(buildRunEnv(provider, true).CLAUDE_CODE_SHELL).toBe("/bin/sh");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SHELL;
      else process.env.CLAUDE_CODE_SHELL = saved;
    }
  });
});

describe("addSchedulingHeaders", () => {
  it("adds the owning session and worker next to the provider header", async () => {
    const { addSchedulingHeaders } = await import("./run-env.js");
    const env: NodeJS.ProcessEnv = { ANTHROPIC_CUSTOM_HEADERS: "x-pai-provider: gyro" };
    addSchedulingHeaders(env, { session: "my session\nx-evil: 1", worker: "20261020-1" });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-pai-provider: gyro\nx-pai-session: my session x-evil  1\nx-pai-worker: 20261020-1");
  });

  it("leaves a run that does not go through the router alone", async () => {
    const { addSchedulingHeaders } = await import("./run-env.js");
    const env: NodeJS.ProcessEnv = {};
    addSchedulingHeaders(env, { session: "s", worker: "w" });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });
});

describe("route preflight", () => {
  const stub = async (status: number, message: string) => {
    const seen: { auth: unknown; key: unknown; body: string }[] = [];
    const s = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, key: req.headers["x-api-key"], body: b });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message } }));
      });
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return { s, seen, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
  };

  it("401 = live, and no credential is sent", async () => {
    const { s, seen, url } = await stub(401, "invalid x-api-key");
    try {
      expect((await probeRoute(url)).live).toBe(true);
      expect(seen[0].auth).toBeUndefined();
      expect(seen[0].key).toBeUndefined();
      expect(JSON.parse(seen[0].body).max_tokens).toBe(1);
    } finally {
      s.close();
    }
  });

  it("502 from the router = broken, names router.claudeUpstream", async () => {
    const { s, url } = await stub(502, "upstream error: ECONNREFUSED");
    try {
      const p = await probeRoute(url);
      expect(p.live).toBe(false);
      expect(p.reason).toContain("502");
      expect(p.reason).toContain("ECONNREFUSED");
      expect(p.fix).toContain("router.claudeUpstream");
    } finally {
      s.close();
    }
  });

  it("refused port = broken, names the router and the start command", async () => {
    const p = await probeRoute("http://127.0.0.1:1");
    expect(p.live).toBe(false);
    expect(p.reason).toContain("http://127.0.0.1:1");
    expect(p.reason).toContain("ECONNREFUSED");
    expect(p.fix).toContain("pai router start");
  });

  it("launch pins the first-party URL when the route is broken, nothing when live", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const broken = nativeLaunchSettingsArgs({}, undefined, () => ({ live: false, reason: "router at X not reachable (ECONNREFUSED)", fix: "start it with: pai router start" }), true);
      expect(JSON.parse(broken[1]).env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
      expect(String(err.mock.calls[0][0])).toContain("launching direct to https://api.anthropic.com");
      expect(nativeLaunchSettingsArgs({}, undefined, () => ({ live: true }), true)).toEqual([]);
      expect(nativeLaunchSettingsArgs({}, undefined, () => ({ live: false }), false)).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });
});
