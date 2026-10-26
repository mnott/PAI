/**
 * config.ts — the OpenCode config fragment PAI writes.
 *
 * Pure: takes what PAI reads from the Claude Code setup (mcpServers of
 * ~/.claude.json, the commands) and returns the `opencode.json` keys that make
 * OpenCode a PAI frontend. OpenCode's shape (1.19.3, its bundled config
 * guide): `mcp.<name>` is `{type:"local", command:[...], environment:{},
 * enabled}` or `{type:"remote", url, headers}`; string values take `{env:VAR}`;
 * `instructions` is a path list; `command.<name>` is `{description, template}`;
 * `plugin` is a list of specs or `[spec, options]` tuples.
 */

export interface ClaudeMcpEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface OpenCodeMcpLocal {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled: boolean;
}
export interface OpenCodeMcpRemote {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled: boolean;
}
export type OpenCodeMcp = OpenCodeMcpLocal | OpenCodeMcpRemote;

export interface McpConversion {
  mcp: Record<string, OpenCodeMcp>;
  /** Env var names the generated config reads; the user must have them exported. Never values. */
  envRefs: string[];
  skipped: { name: string; why: string }[];
}

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase();

/** A secret value never leaves this function as a literal: it becomes an `{env:NAME}` reference. */
function indirect(value: string, name: string, refs: Set<string>): string {
  const m = ENV_REF.exec(value);
  const v = m ? m[1]! : name;
  refs.add(v);
  return `{env:${v}}`;
}

export function convertMcpServers(servers: Record<string, unknown>): McpConversion {
  const mcp: Record<string, OpenCodeMcp> = {};
  const refs = new Set<string>();
  const skipped: { name: string; why: string }[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const e = (raw ?? {}) as ClaudeMcpEntry;
    if (e.url && (e.type === "http" || e.type === "sse" || !e.command)) {
      const headers = e.headers
        ? Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k, indirect(String(v), `PAI_MCP_${slug(name)}_${slug(k)}`, refs)]))
        : undefined;
      mcp[name] = { type: "remote", url: e.url, ...(headers && { headers }), enabled: true };
      continue;
    }
    if (!e.command) {
      skipped.push({ name, why: "no command or url" });
      continue;
    }
    const env = e.env && Object.keys(e.env).length
      ? Object.fromEntries(Object.entries(e.env).map(([k, v]) => [k, indirect(String(v), k, refs)]))
      : undefined;
    mcp[name] = { type: "local", command: [e.command, ...(e.args ?? [])], ...(env && { environment: env }), enabled: true };
  }
  return { mcp, envRefs: [...refs].sort(), skipped };
}

/** One command: Claude Code's `commands/<name>.md` body, frontmatter included. */
export interface CommandSource {
  name: string;
  body: string;
}

export function convertCommands(cmds: CommandSource[]): Record<string, { description: string; template: string }> {
  const out: Record<string, { description: string; template: string }> = {};
  for (const c of cmds) {
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(c.body);
    const body = fm ? c.body.slice(fm[0].length) : c.body;
    const desc = fm && /^description:\s*(.+)$/m.exec(fm[1]!)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    out[c.name] = { description: desc || heading || `PAI command ${c.name}`, template: body.trim() };
  }
  return out;
}

/** A Claude Code PreToolUse hook the bridge plugin runs for OpenCode tool calls. */
export interface BridgeHook {
  /** Lower-case OpenCode tool names. */
  tools: string[];
  /** argv of the hook; it gets Claude-Code-shaped JSON on stdin. */
  command: string[];
}

export interface RenderInput {
  claudeMcpServers: Record<string, unknown>;
  instructionsPath: string;
  commands: CommandSource[];
  bridgePluginUrl: string;
  bridgeHooks: BridgeHook[];
  /** PostToolUse inbox hook (argv); appended to the tool result as additionalContext. */
  inboxHook?: string[];
}

export interface RenderedFragment {
  fragment: Record<string, unknown>;
  envRefs: string[];
  skipped: McpConversion["skipped"];
  commandNames: string[];
}

export function renderOpenCodeConfig(i: RenderInput): RenderedFragment {
  const { mcp, envRefs, skipped } = convertMcpServers(i.claudeMcpServers);
  const command = convertCommands(i.commands);
  return {
    fragment: {
      $schema: "https://opencode.ai/config.json",
      instructions: [i.instructionsPath],
      mcp,
      command,
      plugin: [[i.bridgePluginUrl, { hooks: i.bridgeHooks, ...(i.inboxHook && { inbox: i.inboxHook }) }]],
    },
    envRefs,
    skipped,
    commandNames: Object.keys(command),
  };
}

/**
 * Merge a fragment into an existing opencode.json: PAI's keys win inside
 * mcp/command/provider (so a re-run refreshes them), everything else the user
 * wrote stays, lists gain the PAI entry once (an earlier PAI bridge plugin entry is replaced, wherever it pointed).
 */
export function mergeOpenCodeConfig(existing: Record<string, unknown>, frag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing, ...Object.fromEntries(Object.entries(frag).filter(([k]) => k === "model")) };
  out.$schema = existing.$schema ?? frag.$schema;
  for (const k of ["mcp", "command", "provider"] as const) {
    if (existing[k] === undefined && frag[k] === undefined) continue;
    out[k] = { ...((existing[k] as object) ?? {}), ...((frag[k] as object) ?? {}) };
  }
  out.instructions = [...new Set([...((existing.instructions as string[]) ?? []), ...((frag.instructions as string[]) ?? [])])];
  const specOf = (p: unknown): string => (Array.isArray(p) ? String(p[0]) : String(p));
  const mine = (p: unknown): boolean => specOf(p).includes("pai-bridge");
  out.plugin = [...((existing.plugin as unknown[]) ?? []).filter((p) => !mine(p)), ...((frag.plugin as unknown[]) ?? [])];
  return out;
}
