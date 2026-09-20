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
 *   - model   → a task class via its tier (haiku→simple, sonnet→implement,
 *               opus→complex). Non-Anthropic ids map through the provider
 *               registry (models.fast → haiku tier, models.default → sonnet
 *               tier, a provider's modelTiers override if set), unless
 *               --class is given.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelTier, WorkerProvider } from "./config.js";

export type { ModelTier } from "./config.js";

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

/** Tier → task class: the cheap tier runs as simple, the middle as
 *  implement, the top as complex. */
const TIER_CLASS: Record<ModelTier, string> = {
  haiku: "simple",
  sonnet: "implement",
  opus: "complex",
};

/** Which tier a model id belongs to: one of the CLI's tier aliases, or an
 *  exact match against a configured provider's models (a modelTiers override
 *  first, then fast → haiku tier, default → sonnet tier). null = no match. */
export function modelTier(
  model: string,
  providers?: Record<string, WorkerProvider>
): ModelTier | null {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  if (providers) {
    for (const p of Object.values(providers)) {
      const override = p.modelTiers?.[model];
      if (override) return override;
      if (p.models.fast === model) return "haiku";
      if (p.models.default === model) return "sonnet";
    }
  }
  return null;
}

/** Model ids already warned about — one line per id, not one per run. */
const unmatchedTierLogged = new Set<string>();

/** Map an agent's front-matter model to a worker class. An id that matches
 *  no tier is logged once and falls back to the middle tier's class rather
 *  than dropping the hint silently. */
export function modelToClass(
  model: string | undefined,
  providers?: Record<string, WorkerProvider>
): string | undefined {
  if (!model) return undefined;
  const tier = modelTier(model, providers);
  if (tier) return TIER_CLASS[tier];
  if (!unmatchedTierLogged.has(model)) {
    unmatchedTierLogged.add(model);
    console.error(
      `[agents] model "${model}" matches no known tier — ` +
        `falling back to the ${TIER_CLASS.sonnet} class.`
    );
  }
  return TIER_CLASS.sonnet;
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

/**
 * Default `--label` for a bare `pai worker run` (no --chain/--agent, which
 * derive their own): the prompt's first non-blank line, whitespace-collapsed,
 * stripped of a leading markdown marker (#, *, -, >), truncated to 48 chars
 * with "…" appended if it was cut. An empty/whitespace-only prompt falls back
 * to "worker <class>" so the row is never blank.
 */
export function deriveLabel(prompt: string | null | undefined, klass: string): string {
  const firstLine = (prompt ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return `worker ${klass}`;
  const stripped = firstLine.replace(/^[#*\->]+\s*/, "").replace(/\s+/g, " ").trim();
  if (!stripped) return `worker ${klass}`;
  return stripped.length > 48 ? `${stripped.slice(0, 48)}…` : stripped;
}
