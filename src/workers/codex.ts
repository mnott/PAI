/**
 * codex.ts — the "codex" runner engine.
 *
 * A ChatGPT plan gives no API key, only Codex CLI access, so a provider may
 * set `engine: "codex"`: `run` then shells out to `codex exec --json <prompt>`
 * (non-interactive) instead of Claude Code. The JSONL event stream is parsed
 * into the same status-file fields (turns, tools, last) and ledger lines as a
 * Claude run, and is normalised into claude-code-shaped events in the
 * worker's .jsonl so follow/replay/the pane render it unchanged.
 *
 * Implemented against the documented `codex exec --json` interface
 * (thread.started / item.completed / turn.completed / turn.failed lines);
 * verify against the installed CLI when one is present.
 * `--allowedTools` has no Codex equivalent and is dropped (ledgered).
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync as readKey } from "node:fs";
import { providerKeyPath, type WorkerProvider } from "./config.js";

/** Build the codex exec argument vector (without the binary itself). */
export function buildCodexArgs(prompt: string, model: string | undefined): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...(model ? ["-m", model] : []),
    "--",
    prompt,
  ];
}

/** Env for a codex run: caller's env, Anthropic vars stripped, key applied. */
export function buildCodexEnv(provider: WorkerProvider): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  // API-key providers: OpenAI env from keyFile/baseUrl; ChatGPT-login codex
  // (no keyFile) keeps its own auth from ~/.codex.
  const keyPath = providerKeyPath(provider);
  if (keyPath && existsSync(keyPath)) {
    env.OPENAI_API_KEY = readKey(keyPath, "utf8").trim();
  }
  if (provider.upstreamUrl) env.OPENAI_BASE_URL = provider.upstreamUrl;
  for (const [k, v] of Object.entries(provider.env)) env[k] = v;
  env.PAI_WORKER = "1";
  return env;
}

/** Codex "not applicable" flags the runner drops with a ledger note. */
export function codexDroppedFlags(argv: string[]): string[] {
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
export interface CodexEventResult {
  events: Array<Record<string, unknown>>;
  turns: number;
  tools: number;
  last: string | null;
  isError: boolean;
  contextTokens: number | null;
  finalText: string | null;
  threadId: string | null;
}

export const emptyCodexResult = (): CodexEventResult => ({
  events: [],
  turns: 0,
  tools: 0,
  last: null,
  isError: false,
  contextTokens: null,
  finalText: null,
  threadId: null,
});

/**
 * Fold one parsed `codex exec --json` line into the running result: appends
 * normalised transcript events and updates the counters in place.
 */
export function foldCodexLine(line: unknown, r: CodexEventResult): void {
  if (typeof line !== "object" || line === null) return;
  const e = line as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";

  if (type === "thread.started" && typeof e.thread_id === "string") {
    r.threadId = e.thread_id;
    return;
  }
  if (type === "item.completed" && typeof e.item === "object" && e.item !== null) {
    const item = e.item as Record<string, unknown>;
    const kind = typeof item.type === "string" ? item.type : "";
    if (kind === "agent_message" && typeof item.text === "string") {
      r.turns += 1;
      r.last = `says: ${item.text.slice(0, 70)}`;
      r.finalText = item.text;
      r.events.push({
        type: "assistant",
        message: { content: [{ type: "text", text: item.text }] },
      });
    } else if (kind === "command_execution") {
      r.tools += 1;
      const cmd = typeof item.command === "string" ? item.command : "?";
      const rc = typeof item.exit_code === "number" ? item.exit_code : 0;
      r.last = `Bash: ${cmd.slice(0, 70)}`;
      r.events.push({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] },
      });
      r.events.push({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "",
              is_error: rc !== 0,
              content: item.aggregated_output ?? "",
            },
          ],
        },
      });
    } else if (kind === "file_change") {
      r.tools += 1;
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes
        .map((c) => (typeof c === "object" && c !== null && typeof (c as { path?: unknown }).path === "string" ? (c as { path: string }).path : "?"))
        .join(", ");
      r.last = `files: ${files.slice(0, 70)}`;
      r.events.push({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Write", input: { file_path: files } }] },
      });
    } else if (kind === "mcp_tool_call") {
      r.tools += 1;
      r.last = `mcp: ${String(item.tool ?? "?")}`;
    }
    return;
  }
  if (type === "turn.completed") {
    const usage = (typeof e.usage === "object" && e.usage !== null ? e.usage : {}) as {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
    };
    const tokens =
      (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    if (tokens > 0) r.contextTokens = tokens;
    return;
  }
  if (type === "turn.failed" || type === "error") {
    r.isError = true;
    const err = typeof e.error === "object" && e.error !== null ? e.error : {};
    r.last = String((err as { message?: unknown }).message ?? e.message ?? "codex turn failed");
  }
}

/** Parse one JSONL line; null for blanks and non-JSON noise. */
export function parseCodexLine(line: string): unknown | null {
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

/** True when the Codex CLI is on PATH (test reports "not installed" else). */
export function codexInstalled(): boolean {
  try {
    execFileSync("codex", ["--version"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Spawn helper shared by run and test; caller wires stdout. */
export function spawnCodex(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return spawn("codex", args, { env, cwd, stdio: ["ignore", "pipe", "inherit"] });
}
