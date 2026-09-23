/**
 * Session launch configuration for projects.
 * Implements per-project and global config CRUD (pai project config),
 * and the name/unname/names commands for curated project shortlists.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import chalk from "chalk";
import { ok, warn, err, dim, bold, header, shortenPath, fmtDate, now, renderTable } from "../../utils.js";
import type { ProjectRow, SessionConfig, ConfigOption } from "./types.js";
import { resolveIdentifier, requireProject, getProjectAliases, getProject } from "./helpers.js";
import { paiConfigFilePath } from "../../../daemon/config.js";
import { detectProject } from "../detect.js";
import { expandMcpNames } from "../../../workers/mcp.js";
import { readWorkersSection } from "../../../workers/config.js";
import { getRegistryBackend } from "../../../storage/factory.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_OPTIONS: ConfigOption[] = [
  { key: 'permission', type: 'string', description: 'Permission preset: full | trusted | default', examples: ['full', 'trusted', 'default'] },
  { key: 'flags', type: 'string', description: 'Raw Claude CLI flags', examples: ['--dangerously-skip-permissions', '--allowedTools Edit,Read'] },
  { key: 'env', type: 'object', description: 'Environment variables as key=value pairs', examples: ['IS_SANDBOX=1', 'CLAUDE_MODEL=opus'] },
  { key: 'autoStart', type: 'boolean', description: 'Auto-start session (skip interactive prompt)', examples: ['true', 'false'] },
  { key: 'prompt', type: 'string', description: 'Initial prompt sent to Claude on launch', examples: ['go', 'continue', 'run tests'] },
  { key: 'model', type: 'string', description: 'Model override for the session', examples: ['opus', 'sonnet', 'haiku'] },
];

export const PERMISSION_PRESETS: Record<string, Partial<SessionConfig>> = {
  full: { permission: 'full', flags: '--dangerously-skip-permissions', env: { IS_SANDBOX: '1' }, autoStart: true, prompt: 'go' },
  trusted: { permission: 'trusted', flags: '', env: {}, autoStart: true, prompt: 'go' },
  default: { permission: 'default', flags: '', env: {}, autoStart: false },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getSessionConfig(project: ProjectRow): SessionConfig {
  return project.session_config ? JSON.parse(project.session_config) : {};
}

export function getGlobalDefaults(): SessionConfig {
  try {
    const configPath = paiConfigFilePath();
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return config.sessionDefaults ?? {};
    }
  } catch { /* ignore */ }
  return {};
}

export function saveGlobalDefaults(defaults: SessionConfig): void {
  const configPath = paiConfigFilePath();
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  config.sessionDefaults = defaults;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function applyPreset(config: SessionConfig, preset: string): SessionConfig {
  const presetConfig = PERMISSION_PRESETS[preset];
  if (!presetConfig) {
    return { ...config, permission: 'custom', flags: preset };
  }
  return { ...config, ...presetConfig };
}

/** The registered project whose root_path covers `cwd` (default: process.cwd()). */
async function currentProject(cwd?: string): Promise<ProjectRow | undefined> {
  const detected = await detectProject(cwd);
  if (!detected) return undefined;
  return getProject(detected.slug);
}

async function saveSessionConfig(project: ProjectRow, config: SessionConfig): Promise<void> {
  const backend = await getRegistryBackend();
  await backend.updateProjectSessionConfig(project.id, JSON.stringify(config), now());
}

function splitNames(names: string[]): string[] {
  return names.flatMap((n) => n.split(",").map((s) => s.trim()).filter(Boolean));
}

function parseConfigValue(key: string, value: string): unknown {
  const option = CONFIG_OPTIONS.find(o => o.key === key);
  if (!option) return value;

  switch (option.type) {
    case 'boolean':
      return value === 'true' || value === '1' || value === 'yes';
    case 'object':
      if (key === 'env') {
        const [k, ...vParts] = value.split('=');
        return { [k]: vParts.join('=') || '1' };
      }
      return value;
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function cmdName(
  identifier: string,
  shortname: string,
  opts: { permission?: string }
): Promise<void> {
  const project = (await resolveIdentifier(identifier)) ?? (await requireProject(identifier));
  const backend = await getRegistryBackend();

  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(shortname)) {
    console.error(err(`Invalid name "${shortname}". Use letters, digits, hyphens, underscores. Must start with a letter.`));
    process.exitCode = 1;
    return;
  }

  const conflictProject = await backend.getProjectBySlug(shortname, { excludeId: project.id });
  if (conflictProject) {
    console.error(err(`"${shortname}" is already a project slug.`));
    process.exitCode = 1;
    return;
  }

  const conflictAliasProjectId = await backend.resolveAlias(shortname);
  if (conflictAliasProjectId !== null && conflictAliasProjectId !== project.id) {
    console.error(err(`"${shortname}" is already used by another project.`));
    process.exitCode = 1;
    return;
  }

  if (conflictAliasProjectId === null) {
    await backend.addAlias(shortname, project.id);
  }

  if (opts.permission) {
    const existing = getSessionConfig(project);
    const config = applyPreset(existing, opts.permission);
    await backend.updateProjectSessionConfig(project.id, JSON.stringify(config), now());
  }

  console.log(ok(`Named: ${bold(shortname)} → ${project.slug} (${shortenPath(project.root_path, 50)})`));
  if (opts.permission) {
    console.log(dim(`  Permission: ${opts.permission}`));
  }
}

export async function cmdUnname(shortname: string): Promise<void> {
  const backend = await getRegistryBackend();
  const projectId = await backend.resolveAlias(shortname);

  if (projectId === null) {
    console.error(err(`No named project found: "${shortname}"`));
    process.exitCode = 1;
    return;
  }

  await backend.removeAlias(shortname);

  const remaining = await backend.countAliasesForProject(projectId);

  console.log(ok(`Removed name: ${bold(shortname)}`));
  if (remaining === 0) {
    console.log(dim("  Project has no remaining names."));
  }
}

export async function cmdNames(opts: { json?: boolean; all?: boolean }): Promise<void> {
  // --all: includeUnnamed so projects WITHOUT a curated alias are included too
  //        (for AIBroker's picker to search everything). Unnamed projects get
  //        their slug as the launch key (pai project config resolves by slug).
  const backend = await getRegistryBackend();
  const rows = await backend.listNamedProjects({ includeUnnamed: opts.all });

  if (opts.json) {
    const grouped = new Map<number, unknown>();
    for (const row of rows) {
      if (!grouped.has(row.id)) {
        grouped.set(row.id, {
          name: row.name ?? row.slug, // launch key: alias if named, else slug
          names: row.name ? [row.name] : [],
          slug: row.slug,
          display_name: row.display_name,
          root_path: row.root_path,
          session_count: row.session_count,
          last_active: row.last_active ? new Date(row.last_active).toISOString() : null,
          session_config: row.session_config ? JSON.parse(row.session_config) : null,
        });
      } else if (row.name) {
        (grouped.get(row.id) as { names: string[] }).names.push(row.name);
      }
    }
    console.log(JSON.stringify([...grouped.values()], null, 2));
    return;
  }

  if (!rows.length) {
    console.log(warn("No named projects. Use: pai project name <slug-or-number> <shortname>"));
    return;
  }

  const seen = new Set<number>();
  const tableRows: string[][] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const allNames = rows.filter(r => r.id === row.id).map(r => r.name).filter(Boolean) as string[];
    const config = row.session_config ? JSON.parse(row.session_config) as SessionConfig : null;
    const perm = config?.permission ?? dim('default');

    tableRows.push([
      bold(allNames.length ? allNames.join(', ') : row.slug),
      row.slug,
      dim(shortenPath(row.root_path, 40)),
      typeof perm === 'string' ? perm : dim('default'),
      String(row.session_count),
      fmtDate(row.last_active),
    ]);
  }

  console.log();
  console.log(header("  Named Projects"));
  console.log();
  console.log(renderTable(["Name(s)", "Slug", "Path", "Permission", "Sessions", "Last Active"], tableRows));
  console.log();
  console.log(dim(`  ${tableRows.length} named project(s)`));
}

export async function cmdConfig(
  identifier: string | undefined,
  opts: {
    set?: string[];
    unset?: string[];
    preset?: string;
    defaults?: boolean;
    options?: boolean;
    json?: boolean;
    reset?: boolean;
  }
): Promise<void> {
  // Discovery: list available options
  if (opts.options) {
    if (opts.json) {
      console.log(JSON.stringify({
        options: CONFIG_OPTIONS,
        presets: Object.entries(PERMISSION_PRESETS).map(([name, config]) => ({ name, ...config })),
      }, null, 2));
      return;
    }

    console.log();
    console.log(header("  Session Config Options"));
    console.log();
    console.log(bold("  Available keys:"));
    console.log();
    for (const opt of CONFIG_OPTIONS) {
      console.log(`    ${bold(opt.key.padEnd(14))} ${dim(`(${opt.type})`)}  ${opt.description}`);
      console.log(`    ${' '.repeat(14)}        ${dim('e.g.')} ${opt.examples.map(e => chalk.cyan(e)).join(', ')}`);
    }
    console.log();
    console.log(bold("  Permission presets:"));
    console.log();
    for (const [name, config] of Object.entries(PERMISSION_PRESETS)) {
      const parts = [];
      if (config.flags) parts.push(`flags: ${config.flags}`);
      if (config.env && Object.keys(config.env).length) parts.push(`env: ${Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      if (config.autoStart) parts.push('autoStart');
      if (config.prompt) parts.push(`prompt: "${config.prompt}"`);
      console.log(`    ${bold(name.padEnd(10))} ${dim(parts.join(', ') || '(vanilla)')}`);
    }
    console.log();
    return;
  }

  // Global defaults mode
  if (opts.defaults) {
    let defaults = getGlobalDefaults();

    if (opts.reset) {
      saveGlobalDefaults({});
      console.log(ok("Global session defaults reset."));
      return;
    }

    if (opts.preset) {
      defaults = applyPreset(defaults, opts.preset);
      saveGlobalDefaults(defaults);
      console.log(ok(`Global defaults set to preset: ${bold(opts.preset)}`));
      return;
    }

    if (opts.set?.length) {
      for (const pair of opts.set) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) { console.error(err(`Invalid format: "${pair}". Use key=value.`)); continue; }
        const key = pair.substring(0, eqIdx);
        const value = pair.substring(eqIdx + 1);
        if (!CONFIG_OPTIONS.find(o => o.key === key)) { console.error(err(`Unknown key: "${key}". Run: pai project config --options`)); continue; }
        if (key === 'env') {
          defaults.env = { ...(defaults.env ?? {}), ...(parseConfigValue('env', value) as Record<string, string>) };
        } else {
          (defaults as Record<string, unknown>)[key] = parseConfigValue(key, value);
        }
      }
      saveGlobalDefaults(defaults);
      console.log(ok("Global defaults updated."));
    }

    if (opts.unset?.length) {
      for (const key of opts.unset) {
        if (key.startsWith('env.')) {
          const envKey = key.substring(4);
          if (defaults.env) delete defaults.env[envKey];
        } else {
          delete (defaults as Record<string, unknown>)[key];
        }
      }
      saveGlobalDefaults(defaults);
      console.log(ok("Global defaults updated."));
    }

    if (opts.json) {
      console.log(JSON.stringify(defaults, null, 2));
    } else {
      console.log();
      console.log(header("  Global Session Defaults"));
      console.log();
      if (Object.keys(defaults).length === 0) {
        console.log(dim("  No defaults set. New sessions use vanilla Claude."));
        console.log(dim("  Set with: pai project config --defaults --preset full"));
      } else {
        for (const [key, value] of Object.entries(defaults)) {
          const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
          console.log(`    ${bold(key.padEnd(14))} ${display}`);
        }
      }
      console.log();
    }
    return;
  }

  // Per-project config
  if (!identifier) {
    console.error(err("Specify a project: pai project config <name-or-slug>"));
    console.error(dim("  Or use --defaults for global defaults, --options for available keys."));
    process.exitCode = 1;
    return;
  }

  const project = (await resolveIdentifier(identifier)) ?? (await requireProject(identifier));
  const backend = await getRegistryBackend();
  let config = getSessionConfig(project);

  if (opts.reset) {
    await backend.updateProjectSessionConfig(project.id, null, now());
    console.log(ok(`Config reset for ${bold(project.slug)}. Will use global defaults.`));
    return;
  }

  if (opts.preset) {
    config = applyPreset(config, opts.preset);
    await backend.updateProjectSessionConfig(project.id, JSON.stringify(config), now());
    console.log(ok(`Applied preset ${bold(opts.preset)} to ${bold(project.slug)}`));
  }

  if (opts.set?.length) {
    for (const pair of opts.set) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) { console.error(err(`Invalid format: "${pair}". Use key=value.`)); continue; }
      const key = pair.substring(0, eqIdx);
      const value = pair.substring(eqIdx + 1);
      if (!CONFIG_OPTIONS.find(o => o.key === key)) { console.error(err(`Unknown key: "${key}". Run: pai project config --options`)); continue; }
      if (key === 'env') {
        config.env = { ...(config.env ?? {}), ...(parseConfigValue('env', value) as Record<string, string>) };
      } else {
        (config as Record<string, unknown>)[key] = parseConfigValue(key, value);
      }
    }
    await backend.updateProjectSessionConfig(project.id, JSON.stringify(config), now());
    console.log(ok(`Config updated for ${bold(project.slug)}`));
  }

  if (opts.unset?.length) {
    for (const key of opts.unset) {
      if (key.startsWith('env.')) {
        const envKey = key.substring(4);
        if (config.env) delete config.env[envKey];
      } else {
        delete (config as Record<string, unknown>)[key];
      }
    }
    await backend.updateProjectSessionConfig(project.id, JSON.stringify(config), now());
    console.log(ok(`Config updated for ${bold(project.slug)}`));
  }

  const effective = { ...getGlobalDefaults(), ...config };
  const aliases = await getProjectAliases(project.id);

  if (opts.json) {
    console.log(JSON.stringify({
      project: project.slug,
      names: aliases,
      root_path: project.root_path,
      config,
      global_defaults: getGlobalDefaults(),
      effective,
    }, null, 2));
    return;
  }

  console.log();
  console.log(header(`  Config: ${project.slug}`));
  if (aliases.length) console.log(dim(`  Names: ${aliases.join(', ')}`));
  console.log(dim(`  Path: ${project.root_path}`));
  console.log();

  if (Object.keys(config).length === 0) {
    console.log(dim("  No project-specific config. Using global defaults."));
  } else {
    console.log(bold("  Project config:"));
    for (const [key, value] of Object.entries(config)) {
      const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
      console.log(`    ${bold(key.padEnd(14))} ${display}`);
    }
  }

  const globalDefaults = getGlobalDefaults();
  if (Object.keys(globalDefaults).length > 0) {
    console.log();
    console.log(dim("  Global defaults (overridden by project config):"));
    for (const [key, value] of Object.entries(globalDefaults)) {
      const overridden = key in config;
      const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
      console.log(`    ${dim(key.padEnd(14))} ${overridden ? chalk.strikethrough(display) + ' ' + dim('(overridden)') : display}`);
    }
  }

  console.log();
  console.log(bold("  Effective (what AIBroker uses):"));
  for (const [key, value] of Object.entries(effective)) {
    const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
    console.log(`    ${bold(key.padEnd(14))} ${display}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// MCP / tools pin for the interactive supervisor launch (pai worker run, no -p)
// ---------------------------------------------------------------------------

/**
 * `pai project mcp [names...]` — the MCP servers this project's interactive
 * supervisor session loads. Operates on whichever registered project's
 * root_path covers `opts.cwd` (default: process.cwd()) — run it from inside
 * the project, same as `pai projects here`. Unset (the default) means every
 * configured server loads, today's behavior. Names are validated against
 * ~/.claude.json's mcpServers / workers.mcpSets the same way `--mcp` is.
 */
export async function cmdMcp(
  names: string[],
  opts: { clear?: boolean; cwd?: string } = {}
): Promise<void> {
  const project = await currentProject(opts.cwd);
  if (!project) {
    console.error(err("No registered project matches the current directory."));
    console.error(dim("  Register it first: pai projects here <name>"));
    process.exitCode = 1;
    return;
  }
  const config = getSessionConfig(project);

  if (opts.clear) {
    delete config.mcp;
    await saveSessionConfig(project, config);
    console.log(ok(`MCP servers unset for ${bold(project.slug)} — all servers load again.`));
    return;
  }

  if (!names.length) {
    console.log(config.mcp?.length ? config.mcp.join(",") : "unset (all)");
    return;
  }

  const { workers } = readWorkersSection();
  config.mcp = expandMcpNames(splitNames(names), workers); // unknown names fail fast
  await saveSessionConfig(project, config);
  console.log(ok(`MCP servers set for ${bold(project.slug)}: ${config.mcp.join(", ")}`));
}

/**
 * `pai project tools [names...]` — the built-in tool schemas this project's
 * interactive supervisor session loads (Read, Edit, Bash, …). Same cwd-based
 * project resolution and unset semantics as `cmdMcp`. Unlike MCP names, tool
 * names are not validated against a fixed list — the harness itself rejects
 * an unrecognised one at launch.
 */
export async function cmdTools(
  names: string[],
  opts: { clear?: boolean; cwd?: string } = {}
): Promise<void> {
  const project = await currentProject(opts.cwd);
  if (!project) {
    console.error(err("No registered project matches the current directory."));
    console.error(dim("  Register it first: pai projects here <name>"));
    process.exitCode = 1;
    return;
  }
  const config = getSessionConfig(project);

  if (opts.clear) {
    delete config.tools;
    await saveSessionConfig(project, config);
    console.log(ok(`Tools unset for ${bold(project.slug)} — all built-in tools load again.`));
    return;
  }

  if (!names.length) {
    console.log(config.tools?.length ? config.tools.join(",") : "unset (all)");
    return;
  }

  config.tools = splitNames(names);
  await saveSessionConfig(project, config);
  console.log(ok(`Tools set for ${bold(project.slug)}: ${config.tools.join(", ")}`));
}
