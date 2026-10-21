/**
 * `pai worker providers test`: without a NAME it tests the provider routing
 * would use for a worker now (the t2 tier's first available entry, else the
 * active provider); `test anthropic` probes the local claude CLI through an
 * injected runner (no real claude call, no ANTHROPIC_API_KEY anywhere).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GROUPS } from "../registry.js";
import { runCli, type Io } from "../run.js";
import { makeStyle } from "../help.js";
import { nativeAnthropicProvider } from "../../workers/config.js";
import { testProvider, type ProviderTestDeps } from "../../workers/run.js";

const savedConfigFile = process.env.PAI_CONFIG_FILE;
const savedWorkersYaml = process.env.PAI_WORKERS_YAML;
const savedHome = process.env.HOME;

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s), style: makeStyle(false) }, out, err };
}

/** A fresh install: no user config, no user workers.yaml, no login state (the shipped defaults stand). */
function freshInstall(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-provtest-"));
  process.env.HOME = d;
  process.env.PAI_CONFIG_FILE = join(d, "config.json");
  process.env.PAI_WORKERS_YAML = join(d, "workers.yaml");
  return d;
}

beforeAll(() => freshInstall());
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
  if (savedWorkersYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedWorkersYaml;
});

describe("providers test without a NAME resolves what routing would use", () => {
  it("a fresh install tests the built-in anthropic provider through the claude probe", async () => {
    const d = freshInstall();
    const cli = join(d, "claude");
    writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const run = vi.fn(async (argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) =>
      argv[1] === "--version"
        ? { rc: 0, stdout: "claude 9.9.9", stderr: "" }
        : { rc: 0, stdout: '{"type":"result","result":"pong"}', stderr: "" }
    );
    const c = capture();
    const code = await runCli(GROUPS, ["worker", "providers", "test"], { ...c.io, run });
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
    // the built-in login: version probe, then the pong probe on claude with no provider env
    const argv = run.mock.calls[1][0];
    const env = run.mock.calls[1][1];
    expect(argv[0]).toBe("claude");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const text = c.out.join("\n");
    expect(text).toContain("anthropic");
    expect(text).toContain("t2");
    expect(text).toContain("reply: pong");
  });

  it("the t2 tier's first available entry serves (a down local entry is skipped)", async () => {
    const d = freshInstall();
    const yaml = join(d, "workers.yaml");
    writeFileSync(
      yaml,
      [
        "providers:",
        "  localgyro:",
        "    url: http://127.0.0.1:8099",
        "    models:",
        "      default: gyro-m",
        "  glm:",
        "    url: https://glm.example.invalid",
        "    models:",
        "      default: glm-5.3-flash",
        "tiers:",
        "  - id: t2",
        "    name: Worker",
        "    models: [localgyro, glm]",
        "    default: true",
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
    const run = vi.fn(async (argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) =>
      argv[1] === "--version"
        ? { rc: 0, stdout: "claude 9.9.9", stderr: "" }
        : { rc: 0, stdout: '{"type":"result","result":"pong"}', stderr: "" }
    );
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "providers", "test"], { ...c.io, run })).toBe(0);
    // a cloud provider gets the HTTP pong probe only — no claude version probe
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("--model");
    expect(run.mock.calls[0][1].ANTHROPIC_BASE_URL).toBe("https://glm.example.invalid");
    expect(c.out.join("\n")).toContain("glm");
  });

  it("nothing available and no active provider names the command that sets one", async () => {
    const d = freshInstall();
    writeFileSync(
      join(d, "workers.yaml"),
      [
        "active: glm",
        "providers:",
        "  glm:",
        "    url: https://glm.example.invalid",
        "    enabled: false",
        "    models:",
        "      default: m",
        "tiers:",
        "  - id: t2",
        "    name: Worker",
        "    models: [glm]",
        "    default: true",
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
    const run = vi.fn(async (_argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({ rc: 0, stdout: "", stderr: "" }));
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "providers", "test"], { ...c.io, run })).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(c.err.join("\n")).toContain("no provider available for a worker");
    expect(c.err.join("\n")).toContain("pai worker providers use");
  });
});

describe("providers test anthropic probes the local claude CLI", () => {
  const native = nativeAnthropicProvider();

  it("OK: claude --version answers and the login probe answers", async () => {
    const run = vi.fn(async (argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) =>
      argv[1] === "--version"
        ? { rc: 0, stdout: "claude 9.9.9", stderr: "" }
        : { rc: 0, stdout: '{"type":"result","result":"pong"}', stderr: "" }
    );
    const r = await testProvider("anthropic", native, "/tmp/pai-test-logdir", 5000, { run });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(r.result).toBe("pong");
    // never an API key, never a base URL: the CLI runs on its own login
    for (const call of run.mock.calls) {
      expect(call[1].ANTHROPIC_API_KEY).toBeUndefined();
      expect(call[1].ANTHROPIC_BASE_URL).toBeUndefined();
    }
  });

  it("not installed: claude --version fails, nothing else is probed", async () => {
    const run = vi.fn(async (_argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({ rc: 127, stdout: "", stderr: "" }));
    const r = await testProvider("anthropic", native, "/tmp/pai-test-logdir", 5000, { run });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe("claude CLI not installed");
    expect(r.result).toContain("install Claude Code");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("not logged in: the version answers but the login probe does not", async () => {
    const run = vi.fn(async (argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) =>
      argv[1] === "--version" ? { rc: 0, stdout: "claude 9.9.9", stderr: "" } : { rc: 1, stdout: "", stderr: "Not logged in" }
    );
    const r = await testProvider("anthropic", native, "/tmp/pai-test-logdir", 5000, { run });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe("claude not logged in");
    expect(r.result).toContain("claude");
    expect(r.result).toContain("log in");
  });

  it("OK: a hook-prefixed reply still ends in pong", async () => {
    const run = vi.fn(async (argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) =>
      argv[1] === "--version"
        ? { rc: 0, stdout: "claude 9.9.9", stderr: "" }
        : { rc: 0, stdout: '{"type":"result","result":"[2026-10-21 03:26] pong"}', stderr: "" }
    );
    const r = await testProvider("anthropic", native, "/tmp/pai-test-logdir", 5000, { run });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("[2026-10-21 03:26] pong");
  });

  it("probe failed: any other failure reports the CLI's own words, not a login claim", async () => {
    const run = vi.fn(async (argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) =>
      argv[1] === "--version" ? { rc: 0, stdout: "claude 9.9.9", stderr: "" } : { rc: 1, stdout: "", stderr: "network unreachable" }
    );
    const r = await testProvider("anthropic", native, "/tmp/pai-test-logdir", 5000, { run });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe("probe failed: network unreachable");
  });
});

describe("providers test keeps the HTTP provider path", () => {
  it("a named provider still sends the pong probe through its own route", async () => {
    const d = freshInstall();
    writeFileSync(
      join(d, "workers.yaml"),
      ["providers:", "  glm:", "    url: https://glm.example.invalid", "    models:", "      default: glm-5.3", ""].join("\n"),
      { mode: 0o600 }
    );
    const run = vi.fn(async (_argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({
      rc: 0,
      stdout: '{"type":"result","result":"pong"}',
      stderr: "",
    }));
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "providers", "test", "glm"], { ...c.io, run })).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1].ANTHROPIC_BASE_URL).toBe("https://glm.example.invalid");
    expect(run.mock.calls[0][1].ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.out.join("\n")).toContain("reply: pong");
  });

  it("an unknown NAME is refused without probing anything", async () => {
    const run = vi.fn(async (_argv: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({ rc: 0, stdout: "", stderr: "" }));
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "providers", "test", "nosuch"], { ...c.io, run })).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(c.err.join("\n")).toContain('no provider named "nosuch"');
  });
});
