/**
 * setup.ts — `pai harness setup opencode`: plan and apply.
 *
 * planOpenCodeSetup reads (never writes) what PAI has for Claude Code — the `pai`
 * entry of ~/.claude.json mcpServers, ~/.claude/commands, the templates, the
 * built hooks — and returns the files OpenCode needs. applyOpenCodeSetup writes
 * them, copying any file it changes to <file>.bak-<stamp> first. Every path is a
 * parameter; the caller decides which home it works on.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderInstructions } from "../instructions.js";
import { INSTRUCTIONS_TEMPLATE } from "../instructions.js";
import { opencodeConfigJson } from "../../workers/opencode.js";
import { mergeOpenCodeConfig, renderOpenCodeConfig, type BridgeHook, type CommandSource } from "./config.js";

export interface SetupInput {
  /** The home whose ~/.claude.json, ~/.claude/commands and ~/.claude/skills are read. */
  home: string;
  /** OpenCode's global config dir (default: $XDG_CONFIG_HOME/opencode or ~/.config/opencode). */
  configDir: string;
  /** PAI package root: templates/ and dist/ live here. */
  packageRoot: string;
  /** Register every Claude Code MCP server, not only `pai`. */
  allMcp?: boolean;
  /** Point OpenCode's own model at this PAI-router provider/model. */
  routerProvider?: { name: string; model: string; routerBase?: string };
  stamp?: string;
}

export interface PlannedFile {
  path: string;
  content: string;
  /** Existing content, null when the file is new. */
  before: string | null;
}

export interface SetupPlan {
  files: PlannedFile[];
  mcpServers: string[];
  envRefs: string[];
  commands: string[];
  skills: string[];
  hooks: { hook: string; tools: string[] }[];
  warnings: string[];
}

/** Claude Code hook -> OpenCode tools it guards (the PreToolUse guards that carry PAI's delegation and security rules). */
export const BRIDGED_HOOKS: { hook: string; tools: string[] }[] = [
  { hook: "route-agents-to-worker", tools: ["task"] },
  { hook: "route-edits-to-worker", tools: ["edit", "write", "multiedit", "patch"] },
  { hook: "test-file-governance", tools: ["edit", "write", "multiedit", "patch"] },
  { hook: "block-sleep-poll", tools: ["bash"] },
  { hook: "security-validator", tools: ["bash"] },
];

const readJson = (p: string): Record<string, unknown> | null => {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

function readCommands(dir: string): CommandSource[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: basename(f, ".md"), body: readFileSync(join(dir, f), "utf8") }));
}

function listSkills(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "SKILL.md")))
    .sort();
}

export function planOpenCodeSetup(i: SetupInput): SetupPlan {
  const warnings: string[] = [];
  const claudeJson = readJson(join(i.home, ".claude.json"));
  const all = (claudeJson?.mcpServers ?? {}) as Record<string, unknown>;
  let servers: Record<string, unknown> = i.allMcp ? all : all.pai ? { pai: all.pai } : {};
  if (!servers.pai) {
    const daemonMcp = join(i.packageRoot, "dist", "daemon-mcp", "index.mjs");
    servers = { ...servers, pai: { command: "node", args: [daemonMcp] } };
    warnings.push(`no "pai" in ${join(i.home, ".claude.json")} mcpServers: using ${daemonMcp}`);
  }

  const hooks: BridgeHook[] = [];
  const bridged: SetupPlan["hooks"] = [];
  for (const b of BRIDGED_HOOKS) {
    const file = join(i.packageRoot, "dist", "hooks", `${b.hook}.mjs`);
    if (!existsSync(file)) {
      warnings.push(`hook ${b.hook} not built (${file}): run npm run build, then setup again`);
      continue;
    }
    hooks.push({ tools: b.tools, command: [process.execPath, file] });
    bridged.push(b);
  }

  // PostToolUse inbox hook (operator messages): runs after every tool call and
  // appends its additionalContext to the tool result. Absent means no inbox.
  const inboxFile = join(i.packageRoot, "dist", "hooks", "inbox-inject.mjs");
  const inboxHook = existsSync(inboxFile) ? [process.execPath, inboxFile] : undefined;
  if (inboxHook) bridged.push({ hook: "inbox-inject", tools: ["*"] });

  const paiDir = join(i.configDir, "pai");
  const instructionsPath = join(paiDir, "AGENTS.md");
  const bridgePath = join(paiDir, "pai-bridge.mjs");
  const templatesDir = join(i.packageRoot, "templates");
  const bridgeSrc = join(templatesDir, "opencode", "pai-bridge.mjs");
  const claudeMdTemplate = join(templatesDir, "claude-md.template.md");

  const commands = readCommands(join(i.home, ".claude", "commands"));
  const rendered = renderOpenCodeConfig({
    claudeMcpServers: servers,
    instructionsPath,
    commands,
    bridgePluginUrl: pathToFileURL(bridgePath).href,
    bridgeHooks: hooks,
    inboxHook,
  });
  for (const s of rendered.skipped) warnings.push(`MCP server ${s.name} skipped: ${s.why}`);

  const fragment: Record<string, unknown> = { ...rendered.fragment };
  if (i.routerProvider) {
    const { name, model, routerBase } = i.routerProvider;
    fragment.provider = (JSON.parse(opencodeConfigJson(name, model, routerBase)) as { provider: unknown }).provider;
    fragment.model = `pai/${model}`;
  }

  const configPath = join(i.configDir, "opencode.json");
  const configBefore = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const existing = configBefore ? readJson(configPath) : {};
  if (existing === null) throw new Error(`${configPath} is not valid JSON; fix or move it, nothing was written`);
  const merged = mergeOpenCodeConfig(existing, fragment);

  const doc = [
    "<!-- Generated by `pai harness setup opencode` from PAI's one instruction source. Do not edit; run the command again. -->",
    "",
    renderInstructions("opencode", readFileSync(claudeMdTemplate, "utf8"), i.home).trimEnd(),
    "",
    "---",
    "",
    renderInstructions("opencode", INSTRUCTIONS_TEMPLATE).trimEnd(),
    "",
  ].join("\n");

  const file = (path: string, content: string): PlannedFile => ({ path, content, before: existsSync(path) ? readFileSync(path, "utf8") : null });
  return {
    files: [
      file(configPath, JSON.stringify(merged, null, 2) + "\n"),
      file(instructionsPath, doc),
      file(bridgePath, readFileSync(bridgeSrc, "utf8")),
    ],
    mcpServers: Object.keys(rendered.fragment.mcp as object),
    envRefs: rendered.envRefs,
    commands: rendered.commandNames,
    skills: listSkills(join(i.home, ".claude", "skills")),
    hooks: bridged,
    warnings,
  };
}

/** Write the plan; returns the backup paths made. Unchanged files are left alone. */
export function applyOpenCodeSetup(plan: SetupPlan, stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)): { written: string[]; backups: string[] } {
  const written: string[] = [];
  const backups: string[] = [];
  for (const f of plan.files) {
    if (f.before === f.content) continue;
    mkdirSync(join(f.path, ".."), { recursive: true });
    if (f.before !== null) {
      const bak = `${f.path}.bak-${stamp}`;
      copyFileSync(f.path, bak);
      backups.push(bak);
    }
    writeFileSync(f.path, f.content, "utf8");
    written.push(f.path);
  }
  return { written, backups };
}
