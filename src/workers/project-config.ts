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
import { openRegistry, registryDbPath } from "../registry/db.js";

export interface ProjectLaunchConfig {
  mcp?: string[];
  tools?: string[];
}

interface ConfigRow {
  root_path: string;
  session_config: string | null;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

/**
 * The launch config of the project whose root_path is `cwd` or an ancestor
 * of it (longest match wins) — null when no registered project covers it,
 * or when the matching project has no mcp/tools pin set. `dbPath` is
 * injectable for tests; production callers take the default.
 */
export function projectLaunchConfig(
  cwd: string,
  dbPath: string = registryDbPath()
): ProjectLaunchConfig | null {
  const target = resolve(cwd);
  const db = openRegistry(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT root_path, session_config FROM projects WHERE status != 'archived' ORDER BY LENGTH(root_path) DESC`
      )
      .all() as ConfigRow[];
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
      return mcp || tools ? { mcp, tools } : null;
    }
    return null;
  } finally {
    db.close();
  }
}
