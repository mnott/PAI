/**
 * opencode.ts — the "opencode" runner engine.
 *
 * OpenCode (opencode.ai CLI) is multi-provider, so a provider may set
 * `engine: "opencode"`: `run` then shells out to
 * `opencode run --format json --model pai/<model> --auto --pure -- <prompt>`
 * (non-interactive) instead of Claude Code. The JSONL event stream is parsed
 * into the same status-file fields (turns, tools, last) and ledger lines as a
 * Claude run, and is normalised into claude-code-shaped events in the
 * worker's .jsonl so follow/replay/the pane render it unchanged.
 *
 * Implemented against OpenCode 1.19.3 (`opencode run --help`): event types
 * step_start / text / tool_use (part.tool, part.state.input/output/status) /
 * step_finish (part.reason "tool-calls"|"stop", part.tokens incl. cache) /
 * error — recorded in src/workers/fixtures/opencode-*.jsonl.
 *
 * The model is reached through the PAI router's OpenAI endpoint: a per-worker
 * OPENCODE_CONFIG declares one "pai" provider on the openai-compatible
 * package with options.baseURL = <router base>/p/<provider>/v1 (the router
 * routes by path prefix, splitProviderPrefix), apiKey placeholder "pai" —
 * never the real key. XDG_DATA_HOME is per worker so the session SQLite DB
 * never lands in ~/.local/share/opencode.
 * `--allowedTools` has no OpenCode equivalent and is dropped (ledgered).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routerUrl } from "./run-env.js";
import { providerKeyPath, resolveProviderKey, type WorkerProvider } from "./config.js";

/** Build the opencode run argument vector (without the binary itself). */
export function buildOpencodeArgs(prompt: string, model: string | undefined, sessionId?: string | null): string[] {
  return [
    "run",
    "--format",
    "json",
    ...(model ? ["--model", `pai/${model}`] : []),
    "--auto",
    "--pure",
    "--thinking",
    ...(sessionId ? ["--session", sessionId] : []),
    "--",
    prompt,
  ];
}

/** The per-worker OPENCODE_CONFIG content: one "pai" provider on the router's
 *  OpenAI endpoint (path prefix names the provider), model declared, no MCP. */
export function opencodeConfigJson(providerName: string, model: string, routerBase = routerUrl()): string {
  return JSON.stringify(
    {
      provider: {
        pai: {
          npm: "@ai-sdk/openai-compatible",
          name: "PAI router",
          options: { baseURL: `${routerBase}/p/${providerName}/v1`, apiKey: "pai" },
          models: { [model]: { name: model } },
        },
      },
    },
    null,
    2
  );
}

/**
 * Env for an opencode run: caller's env, Anthropic/OpenAI vars stripped (the
 * router holds the real key — no provider key ever enters this env),
 * OPENCODE_CONFIG written into the worker's scratch dir, XDG_DATA_HOME per
 * worker (sessions live in an SQLite DB under it, never ~/.local/share).
 * `scratch` is the run's scratch dir (applyScratchEnv created it, TMPDIR
 * points at it); the config file and the data home live under it.
 */
export function buildOpencodeEnv(
  provider: WorkerProvider,
  providerName: string,
  model: string,
  scratch: string,
  routerBase = routerUrl()
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const configPath = join(scratch, "opencode-config.json");
  writeFileSync(configPath, opencodeConfigJson(providerName, model, routerBase), "utf8");
  env.OPENCODE_CONFIG = configPath;
  env.XDG_DATA_HOME = join(scratch, "xdg-data");
  // belt and braces: the real key never crosses into the env (the router
  // injects it upstream); a key_file that does not exist is tolerated here
  // (the ChatGPT-login shape of the codex engine, not a broken config)
  const keyPath = providerKeyPath(provider);
  if (provider.key || (keyPath && existsSync(keyPath))) {
    const real = resolveProviderKey(provider);
    for (const k of Object.keys(env)) {
      const v = env[k];
      if (real && v && v.includes(real)) delete env[k];
    }
  }
  for (const [k, v] of Object.entries(provider.env)) env[k] = v;
  env.PAI_WORKER = "1";
  env.PAI_WORKER_PROVIDER = providerName;
  env.PAI_WORKER_MODEL = model;
  return env;
}

/** OpenCode "not applicable" flags the runner drops with a ledger note. */
export function opencodeDroppedFlags(argv: string[]): string[] {
  const dropped: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allowedTools" || a === "--disallowedTools" || a === "--mcp-config" || a === "--mcp") {
      dropped.push(a);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) i++; // and its value
    } else if (a.startsWith("--allowedTools=") || a.startsWith("--mcp-config=")) {
      dropped.push(a.split("=")[0]);
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Event stream parsing (pure — tested with recorded JSONL lines)
// ---------------------------------------------------------------------------

/** One normalised claude-code-shaped event + its effect on the status. */
export interface OpencodeEventResult {
  events: Array<Record<string, unknown>>;
  turns: number;
  tools: number;
  last: string | null;
  isError: boolean;
  contextTokens: number | null;
  finalText: string | null;
  sessionId: string | null;
}

export const emptyOpencodeResult = (): OpencodeEventResult => ({
  events: [],
  turns: 0,
  tools: 0,
  last: null,
  isError: false,
  contextTokens: null,
  finalText: null,
  sessionId: null,
});

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Fold one parsed `opencode run --format json` line into the running result:
 * appends normalised transcript events and updates the counters in place.
 * turns = step_finish count; usage = step_finish.tokens (input + cache.read —
 * the turn's FILL, the input side only, same reading as the codex fold);
 * error -> failure; the last text part is the final result.
 */
export function foldOpencodeLine(line: unknown, r: OpencodeEventResult): void {
  if (typeof line !== "object" || line === null) return;
  const e = line as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  if (typeof e.sessionID === "string" && !r.sessionId) r.sessionId = e.sessionID;

  if (type === "text") {
    const part = asRecord(e.part);
    if (typeof part.text === "string" && part.text) {
      r.last = `says: ${part.text.slice(0, 70)}`;
      r.finalText = part.text;
      r.events.push({
        type: "assistant",
        message: { content: [{ type: "text", text: part.text }] },
      });
    }
    return;
  }
  if (type === "tool_use") {
    const part = asRecord(e.part);
    r.tools += 1;
    const tool = typeof part.tool === "string" ? part.tool : "?";
    const state = asRecord(part.state);
    const input = asRecord(state.input);
    const output = typeof state.output === "string" ? state.output : "";
    const failed = state.status === "error";
    const name = tool === "bash" ? "Bash" : tool.charAt(0).toUpperCase() + tool.slice(1);
    if (tool === "bash" && typeof input.command === "string") r.last = `Bash: ${input.command.slice(0, 70)}`;
    else r.last = `${name}: ${JSON.stringify(input).slice(0, 70)}`;
    r.events.push({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input }] },
    });
    r.events.push({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "", is_error: failed, content: output }] },
    });
    return;
  }
  if (type === "step_finish") {
    r.turns += 1;
    const part = asRecord(e.part);
    const tokens = asRecord(part.tokens);
    const sum = (v: unknown): number => (typeof v === "number" ? v : 0);
    const cache = asRecord(tokens.cache);
    // the context meter is the turn's FILL: the input side only (no output)
    const fill = sum(tokens.input) + sum(cache.read) + sum(cache.write);
    if (fill > 0) r.contextTokens = fill;
    return;
  }
  if (type === "error") {
    r.isError = true;
    const data = asRecord(asRecord(e.error).data);
    r.last = String(data.message ?? e.message ?? "opencode run failed");
    return;
  }
  // step_start and unknown types carry nothing for the status
}

/** Parse one JSONL line; null for blanks and non-JSON noise. */
export function parseOpencodeLine(line: string): unknown | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The engine probe used by `providers test`
// ---------------------------------------------------------------------------

/** True when the OpenCode CLI is on PATH (test reports "not installed" else). */
export function opencodeInstalled(): boolean {
  try {
    execFileSync("opencode", ["--version"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
