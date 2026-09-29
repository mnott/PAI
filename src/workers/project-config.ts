/**
 * project-config.ts — the project registry's optional launch pin, read for
 * the interactive branch of run.ts only: which MCP servers and built-in
 * tools a project's supervisor session (`pai worker run`, no -p) loads. Set
 * with `pai project mcp` / `pai project tools` (src/cli/commands/project/
 * session-config.ts), stored in the same `projects.session_config` JSON
 * column as the rest of a project's launch config. Unset = today's
 * behavior: every server, every tool.
 *
 * A standalone SQL lookup rather than importing the CLI's detectProject:
 * workers/ is a dependency of cli/, not the other way around.
 */

import { resolve } from "node:path";
import { getRegistryBackend } from "../storage/factory.js";
import type { RegistryBackend } from "../storage/registry-interface.js";
import { readMcpServers } from "./mcp.js";

export interface ProjectLaunchConfig {
  slug: string;
  mcp?: string[];
  tools?: string[];
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

/**
 * The launch config of the project whose root_path is `cwd` or an ancestor
 * of it (longest match wins) — null when no registered project covers it,
 * or when the matching project has no mcp/tools pin set. `registry` is
 * injectable for tests; production callers take the process-wide backend.
 */
export async function projectLaunchConfig(
  cwd: string,
  registry?: RegistryBackend
): Promise<ProjectLaunchConfig | null> {
  const target = resolve(cwd);
  const backend = registry ?? (await getRegistryBackend());
  const rows = await backend.listProjectsByPathLengthDesc({ excludeArchived: true });
  for (const row of rows) {
    const root = resolve(row.root_path);
    if (target !== root && !target.startsWith(root + "/")) continue;
    if (!row.session_config) return null;
    let parsed: { mcp?: unknown; tools?: unknown };
    try {
      parsed = JSON.parse(row.session_config);
    } catch {
      return null;
    }
    const mcp = asStringArray(parsed.mcp);
    const tools = asStringArray(parsed.tools);
    return mcp || tools ? { slug: row.slug, mcp, tools } : null;
  }
  return null;
}

/**
 * One line per active pin, so a pin never silently removes a server or tool:
 * shown by the SessionStart hook and by `pai worker run`'s interactive launch.
 * `claudeJson` is injectable for tests; read-only.
 */
export function pinNotices(launch: ProjectLaunchConfig | null, claudeJson?: string): string[] {
  if (!launch) return [];
  const lines: string[] = [];
  if (launch.mcp) {
    const all = Object.keys(readMcpServers(claudeJson));
    const loaded = all.filter((n) => launch.mcp!.includes(n));
    const missing = all.filter((n) => !launch.mcp!.includes(n));
    lines.push(
      `MCP pinned for ${launch.slug}: loading ${loaded.length} of ${all.length} servers; ` +
        `not loaded: ${missing.join(", ") || "(none)"} — \`pai project mcp --clear\` to load all`
    );
  }
  if (launch.tools) {
    lines.push(`Tools pinned for ${launch.slug}: ${launch.tools.join(",")} — \`pai project tools --clear\``);
  }
  return lines;
}
