/**
 * `pai audit tokens subagents` — token cost of every Claude Code subagent
 * definition: `.claude/agents/*.md` under the user's home and (separately)
 * under the current project. A subagent with no `model:` frontmatter field
 * inherits the caller's model at runtime rather than costing a fixed model
 * choice, so it is reported as `"inherits"` rather than left blank.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countTokens, TOKEN_ENCODING } from "./tokens.js";

export interface SubagentEntry {
  path: string;
  tokens: number;
  model: string;
}

export interface SubagentsReport {
  encoding: string;
  entries: SubagentEntry[];
}

/** Strip a single layer of matching quotes ("..." or '...') from a trimmed value. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** The top-level `model:` frontmatter field, or `"inherits"` if absent/empty. */
function parseModel(text: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return "inherits";
  const modelMatch = /^model:\s*(.+)$/m.exec(match[1]);
  if (!modelMatch) return "inherits";
  const value = unquote(modelMatch[1].trim());
  return value === "" ? "inherits" : value;
}

/** Every top-level `.md` file directly under `agentsDir` (not recursive). */
function findAgentFiles(agentsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".md")).map((n) => join(agentsDir, n));
}

function readEntry(path: string): SubagentEntry {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    /* unreadable file: treat as an empty entry rather than throwing */
  }
  return { path, tokens: countTokens(text), model: parseModel(text) };
}

export function auditSubagents(homeDir: string, cwd: string): SubagentsReport {
  const paths = [
    ...findAgentFiles(join(homeDir, ".claude", "agents")),
    ...findAgentFiles(join(cwd, ".claude", "agents")),
  ];
  return { encoding: TOKEN_ENCODING, entries: paths.map(readEntry) };
}
