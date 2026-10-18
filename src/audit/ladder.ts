/**
 * `pai audit tokens ladder` — LIVE: what each layer of headless-worker
 * scaffolding actually costs in first-turn context, measured by spawning the
 * real `claude -p` binary at increasing configuration and reading the
 * `usage` block of its `--output-format json` result. No section above this
 * one makes a network call; this is the one exception, gated behind `--live`.
 *
 * Rungs (each a superset of the last, except L3 which drops every flag):
 *   L0  empty MCP config, no tool schemas at all
 *   L1  same, plus the core file/shell tool schemas (`--tools`)
 *   L2  same as L1, but the empty MCP config is swapped for a real one
 *   L3  plain: none of --strict-mcp-config / --mcp-config / --tools
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { usageContextTokens, type UsageBlock } from "../workers/run.js";
import { ensureNoMcpConfig } from "../workers/paths.js";

export const PROBE_PROMPT = "Reply with exactly the single word OK and nothing else. Do not use any tool.";
export const LADDER_TOOLS = "Bash,Read,Edit,Write,Grep,Glob,Skill,ToolSearch";
export const LADDER_TIMEOUT_MS = 180_000;
export const DEFAULT_LADDER_MODEL = "haiku";

export interface LadderRung {
  id: string;
  description: string;
  /** Full argv (minus the `claude` binary itself). */
  args: string[];
}

/** Build the four rungs' argv. Pure — no spawning, so it's unit-testable. */
export function buildLadderRungs(model: string, emptyMcpPath: string, realMcpPath: string): LadderRung[] {
  const base = ["-p", PROBE_PROMPT, "--model", model, "--output-format", "json"];
  return [
    {
      id: "L0",
      description: "empty MCP config, no tools",
      args: [...base, "--strict-mcp-config", "--mcp-config", emptyMcpPath, "--tools", ""],
    },
    {
      id: "L1",
      description: `empty MCP config, --tools ${LADDER_TOOLS}`,
      args: [...base, "--strict-mcp-config", "--mcp-config", emptyMcpPath, "--tools", LADDER_TOOLS],
    },
    {
      id: "L2",
      description: `real MCP config, --tools ${LADDER_TOOLS}`,
      args: [...base, "--strict-mcp-config", "--mcp-config", realMcpPath, "--tools", LADDER_TOOLS],
    },
    {
      id: "L3",
      description: "plain (no --strict-mcp-config, no --mcp-config, no --tools)",
      args: [...base],
    },
  ];
}

/** Newest `*.mcp.json` in a worker log dir, or null if none exist. */
export function newestMcpConfig(logDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(logDir);
  } catch {
    return null;
  }
  const candidates = files
    .filter((f) => f.endsWith(".mcp.json"))
    .map((f) => join(logDir, f));
  if (candidates.length === 0) return null;
  return candidates
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].path;
}

export interface LadderReading {
  id: string;
  description: string;
  firstTurnContext: number | null;
  timedOut: boolean;
  error?: string;
  /** Delta vs. the previous rung's firstTurnContext; null when either side is missing. */
  delta: number | null;
}

export interface LadderReport {
  model: string;
  mcpConfigPath: string;
  readings: LadderReading[];
}

/** Spawn one rung of `claude -p ...` and read its usage-derived first-turn context. */
function runRung(rung: LadderRung, cwd: string): Promise<{ firstTurnContext: number | null; timedOut: boolean; error?: string }> {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.PAI_WORKER;

    const proc = spawn("claude", rung.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, LADDER_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ firstTurnContext: null, timedOut: false, error: e.message });
    });
    proc.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        resolvePromise({ firstTurnContext: null, timedOut: true });
        return;
      }
      try {
        const parsed = JSON.parse(out.trim()) as { usage?: UsageBlock };
        resolvePromise({ firstTurnContext: usageContextTokens(parsed.usage), timedOut: false });
      } catch (e) {
        resolvePromise({ firstTurnContext: null, timedOut: false, error: (e as Error).message });
      }
    });
  });
}

export async function auditLadder(opts: {
  model?: string;
  mcpConfigPath?: string;
  logDir: string;
  cwd?: string;
}): Promise<LadderReport> {
  const model = opts.model ?? DEFAULT_LADDER_MODEL;
  const emptyMcpPath = ensureNoMcpConfig(opts.logDir);
  const realMcpPath = opts.mcpConfigPath ?? newestMcpConfig(opts.logDir) ?? emptyMcpPath;
  const cwd = opts.cwd ?? process.cwd();

  const rungs = buildLadderRungs(model, emptyMcpPath, realMcpPath);
  const readings: LadderReading[] = [];
  let previous: number | null = null;
  for (const rung of rungs) {
    const result = await runRung(rung, cwd);
    const delta = result.firstTurnContext !== null && previous !== null ? result.firstTurnContext - previous : null;
    readings.push({
      id: rung.id,
      description: rung.description,
      firstTurnContext: result.firstTurnContext,
      timedOut: result.timedOut,
      error: result.error,
      delta,
    });
    if (result.firstTurnContext !== null) previous = result.firstTurnContext;
  }

  return { model, mcpConfigPath: realMcpPath, readings };
}
