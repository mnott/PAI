/**
 * agents.ts — run agent definitions (~/.claude/agents/<name>.md) as workers.
 *
 * The file format is the Claude Code agent one: YAML front matter (`model`,
 * `tools`, `description`) followed by a Markdown body that is the agent's
 * system prompt. `pai worker run --agent <name>` loads it and maps it onto
 * the worker runner:
 *
 *   - body    → --append-system-prompt (prepended, so an explicit caller
 *               flag still wins);
 *   - tools   → --allowedTools;
 *   - model   → a task class (haiku→simple, sonnet→implement, opus→complex),
 *               unless --class is given.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { UNLABELED } from "./status.js";

export interface AgentDef {
  name: string;
  /** Front-matter `model`, when present (any string; mapped via modelToClass). */
  model?: string;
  /** Front-matter `tools`, comma-separated. */
  tools?: string[];
  /** Front-matter `description`. */
  description?: string;
  /** Everything after the front matter — the agent's system prompt. */
  body: string;
  /** The file the definition was read from. */
  path: string;
}

/** Directory the agent library lives in. */
export function agentsDir(): string {
  return join(homedir(), ".claude", "agents");
}

export function agentPath(name: string): string {
  return join(agentsDir(), `${name}.md`);
}

/** `key: value` (bare) or `key: [a, b]` / `key:\n  - a\n  - b` (list). */
function parseFrontMatter(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let key = "";
  for (const raw of text.split("\n")) {
    const listItem = /^\s+-\s+(.*)$/.exec(raw);
    if (listItem && key) {
      const cur = out[key];
      const item = listItem[1].trim().replace(/^["']|["']$/g, "");
      out[key] = Array.isArray(cur) ? [...cur, item] : [item];
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    key = kv[1];
    const val = kv[2].trim();
    if (!val) {
      out[key] = [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      out[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Parse an agent file's text (front matter + body). Throws on empty body. */
export function parseAgentFile(name: string, text: string, path: string): AgentDef {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) {
    throw new Error(
      `${path}: expected YAML front matter (--- … ---) before the agent body`
    );
  }
  const fm = parseFrontMatter(m[1]);
  const body = m[2].trim();
  if (!body) throw new Error(`${path}: the agent body (after the front matter) is empty`);
  const def: AgentDef = { name, body, path };
  if (typeof fm.model === "string" && fm.model) def.model = fm.model;
  if (Array.isArray(fm.tools) && fm.tools.length) def.tools = fm.tools;
  if (typeof fm.description === "string" && fm.description) def.description = fm.description;
  return def;
}

/** Load ~/.claude/agents/<name>.md; the error names the library when missing. */
export function loadAgent(name: string): AgentDef {
  const path = agentPath(name);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no agent named "${name}" at ${path}. ` +
        `The agent library lives in ~/.claude/agents/<name>.md and runs on workers.`
    );
  }
  return parseAgentFile(name, text, path);
}

/** Map an agent's front-matter model to a worker class. */
export function modelToClass(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "simple";
  if (m.includes("sonnet")) return "implement";
  if (m.includes("opus")) return "complex";
  return undefined;
}

/** Extra claude args the definition contributes (before the caller's own). */
export function agentClaudeArgs(def: AgentDef): string[] {
  const args: string[] = [];
  if (def.tools?.length) args.push("--allowedTools", def.tools.join(","));
  args.push("--append-system-prompt", def.body);
  return args;
}

/** `<agent>: <first 50 chars of prompt>` — the default label for a run. */
export function agentLabel(name: string, prompt: string | null | undefined): string {
  return `${name}: ${prompt ?? UNLABELED}`.slice(0, name.length + 2 + 50);
}
