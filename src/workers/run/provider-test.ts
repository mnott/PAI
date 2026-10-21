/**
 * run/provider-test.ts — the provider pong probe, moved verbatim out of
 * run.ts (split plan step 1). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { spawn } from "node:child_process";
import {
  assertProviderRunnable,
  type WorkerProvider,
} from "../config.js";
import { buildRunEnv, claudeCommand } from "../run-env.js";
import { codexInstalled } from "../codex.js";
import { ensureNoMcpConfig } from "../paths.js";
import { DEFAULT_PROXY_PORT, ensureProxyRunning } from "../proxy/server.js";
import { type StreamEvent } from "./types.js";

export interface ProviderTestResult {
  provider: string;
  model: string;
  latencyMs: number;
  result: string;
  ok: boolean;
  /** Set when the probe could not run (e.g. "codex not installed"). */
  skipped?: string;
}

/** One spawned probe process: exit code plus its captured stdout/stderr. */
export interface ProbeRunResult {
  rc: number;
  stdout: string;
  stderr: string;
}

/** Spawn seam of the probes (tests inject a runner; no real claude call). */
export interface ProviderTestDeps {
  run?: (argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProbeRunResult>;
}

/** Spawn `argv` with `env`, capture stdout/stderr, kill it after `timeoutMs`. */
function runProbeProcess(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeRunResult> {
  const [bin, ...rest] = argv;
  const proc = spawn(bin, rest, { env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ rc: 1, stdout, stderr });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ rc: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * The native `anthropic` probe: the local Claude Code CLI, on its own login.
 * `claude --version` first (not installed → say so, probe nothing else), then
 * the same one-word pong through the login (not logged in → the reply is not
 * pong). Never an ANTHROPIC_API_KEY: buildRunEnv strips it and the native env
 * carries no provider route at all.
 */
async function testNativeClaude(
  providerName: string,
  provider: WorkerProvider,
  logDir: string,
  timeoutMs: number,
  caveman: boolean,
  run: (argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProbeRunResult>
): Promise<ProviderTestResult> {
  const model = provider.models.default;
  const base = { provider: providerName, model, latencyMs: 0 };
  // the CLI's own login: a bare `claude`, no provider env and no --settings
  // pin — and the API key never crosses into the spawn (buildRunEnv strips it)
  const loginEnv = buildRunEnv(provider, true, undefined, providerName);
  const version = await run(["claude", "--version"], loginEnv, 10_000);
  if (version.rc !== 0) {
    return {
      ...base,
      result: "install Claude Code (https://docs.anthropic.com/en/docs/claude-code), then run this again",
      ok: false,
      skipped: "claude CLI not installed",
    };
  }
  const t0 = Date.now();
  const pong = await run(
    ["claude", "--model", model, "--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir), "-p", "Reply with exactly one word: pong", "--output-format", "json"],
    loginEnv,
    timeoutMs
  );
  const latencyMs = Date.now() - t0;
  const reply = resultFromOutput(pong.stdout).trim();
  // hooks may prefix the reply (e.g. a timestamp), so the last word decides
  if (pong.rc === 0 && /(^|\s)pong[.!]?$/i.test(reply)) {
    return { ...base, latencyMs, result: reply, ok: true };
  }
  const out = `${pong.stderr}\n${reply || pong.stdout}`;
  if (/not logged in|please run \/login|invalid api key|authentication|oauth|\b401\b/i.test(out)) {
    return {
      ...base,
      latencyMs,
      result: "run `claude` once and log in (its own OAuth/Max-plan login is what workers run on)",
      ok: false,
      skipped: "claude not logged in",
    };
  }
  const detail = out.replace(/\s+/g, " ").trim().slice(0, 160) || `rc ${pong.rc}, no output`;
  return { ...base, latencyMs, result: detail, ok: false, skipped: `probe failed: ${detail}` };
}

/**
 * Run a one-word pong probe through the provider (headless, no pane) and
 * report provider, model, latency and the reply. ok is false unless the reply
 * was exactly "pong" (case-insensitive, whitespace-trimmed). The built-in
 * native `anthropic` provider has no API to probe: it checks the local claude
 * CLI instead (installed + logged in). `deps.run` replaces the spawn (tests).
 */
export async function testProvider(
  providerName: string,
  provider: WorkerProvider,
  logDir: string,
  timeoutMs = 90_000,
  caveman = false,
  deps: ProviderTestDeps = {}
): Promise<ProviderTestResult> {
  assertProviderRunnable(providerName, provider);
  const run = deps.run ?? runProbeProcess;
  const model = provider.models.default;

  if (provider.native) return testNativeClaude(providerName, provider, logDir, timeoutMs, caveman, run);

  if (provider.engine === "codex") {
    const skipped = codexInstalled() ? undefined : "codex not installed";
    return {
      provider: providerName,
      model,
      latencyMs: 0,
      result: skipped ?? "codex engine: pong probe through codex exec not implemented",
      ok: false,
      ...(skipped ? { skipped } : {}),
    };
  }

  let proxyUrl: string | undefined;
  if (provider.protocol === "openai") {
    const base = await ensureProxyRunning(DEFAULT_PROXY_PORT, logDir);
    proxyUrl = `${base}/${providerName}`;
  }
  const env = buildRunEnv(provider, true, proxyUrl, providerName);
  const [bin, ...head] = claudeCommand(env, caveman);
  const t0 = Date.now();
  const r = await run(
    [
      bin,
      ...head,
      "--model", model,
      "--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir),
      "-p", "Reply with exactly one word: pong",
      "--output-format", "json",
    ],
    env,
    timeoutMs
  );
  return {
    provider: providerName,
    model,
    latencyMs: Date.now() - t0,
    result: resultFromOutput(r.stdout),
    ok: r.rc === 0 && resultFromOutput(r.stdout).trim().toLowerCase() === "pong",
  };
}

/**
 * Pull the reply out of claude's stdout. With --verbose, `--output-format
 * json` dumps a JSON array of stream events and the reply sits in the last
 * "result" event; without it, stdout is the single result object. Accept
 * either shape, plus a bare-text fallback for error output.
 */
export function resultFromOutput(out: string): string {
  const trimmed = out.trim();
  if (!trimmed) return "";
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const fromValue = (v: unknown): string | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        const r = fromValue(v[i]);
        if (r !== null) return r;
      }
      return null;
    }
    if (typeof v === "object" && v !== null) {
      const o = v as StreamEvent;
      if (o.type === "result" && typeof o.result === "string") return o.result;
    }
    return null;
  };
  const direct = fromValue(parse(trimmed));
  if (direct !== null) return direct;
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = fromValue(parse(lines[i]));
    if (r !== null) return r;
  }
  return trimmed.slice(0, 200);
}
