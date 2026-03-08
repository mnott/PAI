/**
 * MCP tool handlers: project_info, project_list, project_detect,
 *                    project_health, project_todo
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { detectProject, formatDetectionJson } from "../../cli/commands/detect.js";
import {
  lookupProjectId,
  detectProjectFromPath,
  formatProject,
  type ProjectRow,
  type ToolResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tool: project_info
// ---------------------------------------------------------------------------

export interface ProjectInfoParams {
  slug?: string;
}

export function toolProjectInfo(
  registryDb: Database,
  params: ProjectInfoParams
): ToolResult {
  try {
    let project: ProjectRow | null = null;

    if (params.slug) {
      const projectId = lookupProjectId(registryDb, params.slug);
      if (projectId != null) {
        project = registryDb
          .prepare(
            "SELECT id, slug, display_name, root_path, type, status, created_at, updated_at, archived_at, parent_id, obsidian_link FROM projects WHERE id = ?"
          )
          .get(projectId) as ProjectRow | null;
      }
    } else {
      const cwd = process.cwd();
      project = detectProjectFromPath(registryDb, cwd);
    }

    if (!project) {
      const message = params.slug
        ? `Project not found: ${params.slug}`
        : `No PAI project found matching the current directory: ${process.cwd()}`;
      return {
        content: [{ type: "text", text: message }],
        isError: !params.slug,
      };
    }

    return {
      content: [{ type: "text", text: formatProject(registryDb, project) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `project_info error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: project_list
// ---------------------------------------------------------------------------

export interface ProjectListParams {
  status?: "active" | "archived" | "migrating";
  tag?: string;
  limit?: number;
}

export function toolProjectList(
  registryDb: Database,
  params: ProjectListParams
): ToolResult {
  try {
    const conditions: string[] = [];
    const queryParams: (string | number)[] = [];

    if (params.status) {
      conditions.push("p.status = ?");
      queryParams.push(params.status);
    }

    if (params.tag) {
      conditions.push(
        "p.id IN (SELECT pt.project_id FROM project_tags pt JOIN tags t ON pt.tag_id = t.id WHERE t.name = ?)"
      );
      queryParams.push(params.tag);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit ?? 50;
    queryParams.push(limit);

    const projects = registryDb
      .prepare(
        `SELECT p.id, p.slug, p.display_name, p.root_path, p.type, p.status, p.updated_at
         FROM projects p
         ${where}
         ORDER BY p.updated_at DESC
         LIMIT ?`
      )
      .all(...queryParams) as Array<{
      id: number;
      slug: string;
      display_name: string;
      root_path: string;
      type: string;
      status: string;
      updated_at: number;
    }>;

    if (projects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No projects found matching the given filters.",
          },
        ],
      };
    }

    const lines = projects.map(
      (p) =>
        `${p.slug}  [${p.status}]  ${p.root_path}  (updated: ${new Date(p.updated_at).toISOString().slice(0, 10)})`
    );

    return {
      content: [
        {
          type: "text",
          text: `${projects.length} project(s):\n\n${lines.join("\n")}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `project_list error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: project_detect
// ---------------------------------------------------------------------------

export interface ProjectDetectParams {
  cwd?: string;
}

export function toolProjectDetect(
  registryDb: Database,
  params: ProjectDetectParams
): ToolResult {
  try {
    const detection = detectProject(registryDb, params.cwd);

    if (!detection) {
      const target = params.cwd ?? process.cwd();
      return {
        content: [
          {
            type: "text",
            text: `No registered project found for path: ${target}\n\nRun 'pai project add .' to register this directory.`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: formatDetectionJson(detection) }],
    };
  } catch (e) {
    return {
      content: [
        { type: "text", text: `project_detect error: ${String(e)}` },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: project_health
// ---------------------------------------------------------------------------

export interface ProjectHealthParams {
  category?: "active" | "stale" | "dead" | "all";
}

export async function toolProjectHealth(
  registryDb: Database,
  params: ProjectHealthParams
): Promise<ToolResult> {
  try {
    const { existsSync: fsExists, readdirSync, statSync } = await import(
      "node:fs"
    );
    const {
      join: pathJoin,
      basename: pathBasename,
    } = await import("node:path");
    const { homedir } = await import("node:os");
    const { encodeDir: enc } = await import("../../cli/utils.js");

    interface HealthRowLocal {
      id: number;
      slug: string;
      display_name: string;
      root_path: string;
      encoded_dir: string;
      status: string;
      type: string;
      session_count: number;
    }

    const rows = registryDb
      .prepare(
        `SELECT p.id, p.slug, p.display_name, p.root_path, p.encoded_dir, p.status, p.type,
           (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count
         FROM projects p
         ORDER BY p.slug ASC`
      )
      .all() as HealthRowLocal[];

    const home = homedir();
    const claudeProjects = pathJoin(home, ".claude", "projects");

    function suggestMoved(rootPath: string): string | undefined {
      const name = pathBasename(rootPath);
      const candidates = [
        pathJoin(home, "dev", name),
        pathJoin(home, "dev", "ai", name),
        pathJoin(home, "Desktop", name),
        pathJoin(home, "Projects", name),
      ];
      return candidates.find((c) => fsExists(c));
    }

    function hasClaudeNotes(encodedDir: string): boolean {
      if (!fsExists(claudeProjects)) return false;
      try {
        for (const entry of readdirSync(claudeProjects)) {
          if (entry !== encodedDir && !entry.startsWith(encodedDir)) continue;
          const full = pathJoin(claudeProjects, entry);
          try {
            if (!statSync(full).isDirectory()) continue;
          } catch {
            continue;
          }
          if (fsExists(pathJoin(full, "Notes"))) return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    }

    interface HealthResult {
      slug: string;
      display_name: string;
      root_path: string;
      status: string;
      type: string;
      session_count: number;
      health: string;
      suggested_path: string | null;
      has_claude_notes: boolean;
      todo: {
        found: boolean;
        path: string | null;
        has_continue: boolean;
      };
    }

    function findTodoForProject(rootPath: string): {
      found: boolean;
      path: string | null;
      has_continue: boolean;
    } {
      const locs = [
        "Notes/TODO.md",
        ".claude/Notes/TODO.md",
        "tasks/todo.md",
        "TODO.md",
      ];
      for (const rel of locs) {
        const full = pathJoin(rootPath, rel);
        if (fsExists(full)) {
          try {
            const raw = readFileSync(full, "utf8");
            const hasContinue = /^## Continue$/m.test(raw);
            return { found: true, path: rel, has_continue: hasContinue };
          } catch {
            return { found: true, path: rel, has_continue: false };
          }
        }
      }
      return { found: false, path: null, has_continue: false };
    }

    const results: HealthResult[] = rows.map((p) => {
      const pathExists = fsExists(p.root_path);
      let health: string;
      let suggestedPath: string | null = null;

      if (pathExists) {
        health = "active";
      } else {
        suggestedPath = suggestMoved(p.root_path) ?? null;
        health = suggestedPath ? "stale" : "dead";
      }

      const todo = pathExists
        ? findTodoForProject(p.root_path)
        : { found: false, path: null, has_continue: false };

      return {
        slug: p.slug,
        display_name: p.display_name,
        root_path: p.root_path,
        status: p.status,
        type: p.type,
        session_count: p.session_count,
        health,
        suggested_path: suggestedPath,
        has_claude_notes: hasClaudeNotes(p.encoded_dir),
        todo,
      };
    });

    const filtered =
      !params.category || params.category === "all"
        ? results
        : results.filter((r) => r.health === params.category);

    const summary = {
      total: rows.length,
      active: results.filter((r) => r.health === "active").length,
      stale: results.filter((r) => r.health === "stale").length,
      dead: results.filter((r) => r.health === "dead").length,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ summary, projects: filtered }, null, 2),
        },
      ],
    };
  } catch (e) {
    return {
      content: [
        { type: "text", text: `project_health error: ${String(e)}` },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: project_todo
// ---------------------------------------------------------------------------

export interface ProjectTodoParams {
  project?: string;
}

/**
 * TODO candidate locations searched in priority order.
 * Returns the first one that exists, along with its label.
 */
const TODO_LOCATIONS = [
  { rel: "Notes/TODO.md",       label: "Notes/TODO.md" },
  { rel: ".claude/Notes/TODO.md", label: ".claude/Notes/TODO.md" },
  { rel: "tasks/todo.md",       label: "tasks/todo.md" },
  { rel: "TODO.md",             label: "TODO.md" },
];

/**
 * Given TODO file content, extract and surface the ## Continue section first,
 * then return the remaining content. Returns an object with:
 *   continueSection: string | null
 *   fullContent: string
 *   hasContinue: boolean
 */
function parseTodoContent(raw: string): {
  continueSection: string | null;
  fullContent: string;
  hasContinue: boolean;
} {
  const lines = raw.split("\n");

  // Find the ## Continue heading
  const continueIdx = lines.findIndex(
    (l) => l.trim() === "## Continue"
  );

  if (continueIdx === -1) {
    return { continueSection: null, fullContent: raw, hasContinue: false };
  }

  // The section ends at the first `---` separator or next `##` heading after
  // the Continue heading (whichever comes first).
  let endIdx = lines.length;
  for (let i = continueIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || (trimmed.startsWith("##") && trimmed !== "## Continue")) {
      endIdx = i;
      break;
    }
  }

  const continueLines = lines.slice(continueIdx, endIdx);
  const continueSection = continueLines.join("\n").trim();

  return { continueSection, fullContent: raw, hasContinue: true };
}

export function toolProjectTodo(
  registryDb: Database,
  params: ProjectTodoParams
): ToolResult {
  try {
    let rootPath: string;
    let projectSlug: string;

    if (params.project) {
      const projectId = lookupProjectId(registryDb, params.project);
      if (projectId == null) {
        return {
          content: [
            { type: "text", text: `Project not found: ${params.project}` },
          ],
          isError: true,
        };
      }

      const row = registryDb
        .prepare("SELECT root_path, slug FROM projects WHERE id = ?")
        .get(projectId) as { root_path: string; slug: string } | undefined;

      if (!row) {
        return {
          content: [
            { type: "text", text: `Project not found: ${params.project}` },
          ],
          isError: true,
        };
      }

      rootPath = row.root_path;
      projectSlug = row.slug;
    } else {
      // Auto-detect from cwd
      const project = detectProjectFromPath(registryDb, process.cwd());
      if (!project) {
        return {
          content: [
            {
              type: "text",
              text: `No PAI project found matching the current directory: ${process.cwd()}\n\nProvide a project slug or run 'pai project add .' to register this directory.`,
            },
          ],
        };
      }
      rootPath = project.root_path;
      projectSlug = project.slug;
    }

    // Search for TODO in priority order
    for (const loc of TODO_LOCATIONS) {
      const fullPath = join(rootPath, loc.rel);
      if (existsSync(fullPath)) {
        const raw = readFileSync(fullPath, "utf8");
        const { continueSection, fullContent, hasContinue } = parseTodoContent(raw);

        let output: string;
        if (hasContinue && continueSection) {
          // Surface the ## Continue section first, then the full content
          output = [
            `TODO found: ${projectSlug}/${loc.label}`,
            "",
            "=== CONTINUE SECTION (surfaced first) ===",
            continueSection,
            "",
            "=== FULL TODO CONTENT ===",
            fullContent,
          ].join("\n");
        } else {
          output = [
            `TODO found: ${projectSlug}/${loc.label}`,
            "",
            fullContent,
          ].join("\n");
        }

        return {
          content: [{ type: "text", text: output }],
        };
      }
    }

    // No TODO found in any location
    const searched = TODO_LOCATIONS.map((l) => `  ${rootPath}/${l.rel}`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: [
            `No TODO.md found for project: ${projectSlug}`,
            "",
            "Searched locations (in order):",
            searched,
            "",
            "Create a TODO with: echo '## Tasks\\n- [ ] First task' > Notes/TODO.md",
          ].join("\n"),
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `project_todo error: ${String(e)}` }],
      isError: true,
    };
  }
}
