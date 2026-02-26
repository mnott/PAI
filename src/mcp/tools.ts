/**
 * PAI Knowledge OS — Pure tool handler functions (shared by daemon + legacy MCP server)
 *
 * Each function accepts pre-opened database handles and raw params, executes
 * the tool logic, and returns an MCP-style content array.
 *
 * This module does NOT import indexAll() — indexing is handled by the daemon
 * on its own schedule. The search hot path is pure DB read.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { Database } from "better-sqlite3";
import { populateSlugs, searchMemoryHybrid } from "../memory/search.js";
import { detectProject, formatDetectionJson } from "../cli/commands/detect.js";
import type { StorageBackend } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Helper: lookup project_id by slug (also checks aliases)
// ---------------------------------------------------------------------------

export function lookupProjectId(
  registryDb: Database,
  slug: string
): number | null {
  const bySlug = registryDb
    .prepare("SELECT id FROM projects WHERE slug = ?")
    .get(slug) as { id: number } | undefined;
  if (bySlug) return bySlug.id;

  const byAlias = registryDb
    .prepare("SELECT project_id FROM aliases WHERE alias = ?")
    .get(slug) as { project_id: number } | undefined;
  if (byAlias) return byAlias.project_id;

  return null;
}

// ---------------------------------------------------------------------------
// Helper: detect project from a filesystem path
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  type: string;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at?: number | null;
  parent_id?: number | null;
  obsidian_link?: string | null;
}

export function detectProjectFromPath(
  registryDb: Database,
  fsPath: string
): ProjectRow | null {
  const resolved = resolve(fsPath);

  const exact = registryDb
    .prepare(
      "SELECT id, slug, display_name, root_path, type, status, created_at, updated_at FROM projects WHERE root_path = ?"
    )
    .get(resolved) as ProjectRow | undefined;

  if (exact) return exact;

  const all = registryDb
    .prepare(
      "SELECT id, slug, display_name, root_path, type, status, created_at, updated_at FROM projects ORDER BY LENGTH(root_path) DESC"
    )
    .all() as ProjectRow[];

  for (const project of all) {
    if (
      resolved.startsWith(project.root_path + "/") ||
      resolved === project.root_path
    ) {
      return project;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: format project row for tool output
// ---------------------------------------------------------------------------

export function formatProject(registryDb: Database, project: ProjectRow): string {
  const sessionCount = (
    registryDb
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?")
      .get(project.id) as { n: number }
  ).n;

  const lastSession = registryDb
    .prepare(
      "SELECT date FROM sessions WHERE project_id = ? ORDER BY date DESC LIMIT 1"
    )
    .get(project.id) as { date: string } | undefined;

  const tags = (
    registryDb
      .prepare(
        `SELECT t.name FROM tags t
         JOIN project_tags pt ON pt.tag_id = t.id
         WHERE pt.project_id = ?
         ORDER BY t.name`
      )
      .all(project.id) as Array<{ name: string }>
  ).map((r) => r.name);

  const aliases = (
    registryDb
      .prepare("SELECT alias FROM aliases WHERE project_id = ? ORDER BY alias")
      .all(project.id) as Array<{ alias: string }>
  ).map((r) => r.alias);

  const lines: string[] = [
    `slug: ${project.slug}`,
    `display_name: ${project.display_name}`,
    `root_path: ${project.root_path}`,
    `type: ${project.type}`,
    `status: ${project.status}`,
    `sessions: ${sessionCount}`,
  ];

  if (lastSession) lines.push(`last_session: ${lastSession.date}`);
  if (tags.length) lines.push(`tags: ${tags.join(", ")}`);
  if (aliases.length) lines.push(`aliases: ${aliases.join(", ")}`);
  if (project.obsidian_link) lines.push(`obsidian_link: ${project.obsidian_link}`);
  if (project.archived_at) {
    lines.push(
      `archived_at: ${new Date(project.archived_at).toISOString().slice(0, 10)}`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool: memory_search
// ---------------------------------------------------------------------------

export interface MemorySearchParams {
  query: string;
  project?: string;
  all_projects?: boolean;
  sources?: Array<"memory" | "notes">;
  limit?: number;
  mode?: "keyword" | "semantic" | "hybrid";
}

export async function toolMemorySearch(
  registryDb: Database,
  federation: Database | StorageBackend,
  params: MemorySearchParams
): Promise<ToolResult> {
  try {
    const projectIds: number[] | undefined = params.project
      ? (() => {
          const id = lookupProjectId(registryDb, params.project!);
          return id != null ? [id] : [];
        })()
      : undefined;

    if (params.project && (!projectIds || projectIds.length === 0)) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    // NOTE: No indexAll() here — indexing is handled by the daemon scheduler.
    // The daemon ensures the index stays fresh; the search hot path is read-only.

    const mode = params.mode ?? "keyword";
    const searchOpts = {
      projectIds,
      sources: params.sources,
      maxResults: params.limit ?? 10,
    };

    let results;

    // Determine if federation is a StorageBackend or a raw Database
    const isBackend = (x: Database | StorageBackend): x is StorageBackend =>
      "backendType" in x;

    if (isBackend(federation)) {
      // Use the storage backend interface (works for both SQLite and Postgres)
      if (mode === "keyword") {
        results = await federation.searchKeyword(params.query, searchOpts);
      } else if (mode === "semantic" || mode === "hybrid") {
        const { generateEmbedding } = await import("../memory/embeddings.js");
        const queryEmbedding = await generateEmbedding(params.query, true);

        if (mode === "semantic") {
          results = await federation.searchSemantic(queryEmbedding, searchOpts);
        } else {
          // Hybrid: combine keyword + semantic
          const [kwResults, semResults] = await Promise.all([
            federation.searchKeyword(params.query, { ...searchOpts, maxResults: 500 }),
            federation.searchSemantic(queryEmbedding, { ...searchOpts, maxResults: 500 }),
          ]);
          // Reuse the existing hybrid scoring logic
          results = combineHybridResults(kwResults, semResults, searchOpts.maxResults ?? 10);
        }
      } else {
        results = await federation.searchKeyword(params.query, searchOpts);
      }
    } else {
      // Legacy path: raw better-sqlite3 Database (for direct MCP server usage)
      const { searchMemory, searchMemorySemantic } = await import("../memory/search.js");

      if (mode === "keyword") {
        results = searchMemory(federation, params.query, searchOpts);
      } else if (mode === "semantic" || mode === "hybrid") {
        const { generateEmbedding } = await import("../memory/embeddings.js");
        const queryEmbedding = await generateEmbedding(params.query, true);

        if (mode === "semantic") {
          results = searchMemorySemantic(federation, queryEmbedding, searchOpts);
        } else {
          results = searchMemoryHybrid(
            federation,
            params.query,
            queryEmbedding,
            searchOpts
          );
        }
      } else {
        results = searchMemory(federation, params.query, searchOpts);
      }
    }

    const withSlugs = populateSlugs(results, registryDb);

    if (withSlugs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results found for query: "${params.query}" (mode: ${mode})`,
          },
        ],
      };
    }

    const formatted = withSlugs
      .map((r, i) => {
        const header = `[${i + 1}] ${r.projectSlug ?? `project:${r.projectId}`} — ${r.path} (lines ${r.startLine}-${r.endLine}) score=${r.score.toFixed(4)} tier=${r.tier} source=${r.source}`;
        const snippet = r.snippet.trim().slice(0, 500);
        return `${header}\n${snippet}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${withSlugs.length} result(s) for "${params.query}" (mode: ${mode}):\n\n${formatted}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Search error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: memory_get
// ---------------------------------------------------------------------------

export interface MemoryGetParams {
  project: string;
  path: string;
  from?: number;
  lines?: number;
}

export function toolMemoryGet(
  registryDb: Database,
  params: MemoryGetParams
): ToolResult {
  try {
    const projectId = lookupProjectId(registryDb, params.project);
    if (projectId == null) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    const project = registryDb
      .prepare("SELECT root_path FROM projects WHERE id = ?")
      .get(projectId) as { root_path: string } | undefined;

    if (!project) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    const requestedPath = params.path;
    if (requestedPath.includes("..") || isAbsolute(requestedPath)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid path: ${params.path} (must be a relative path within the project root, no ../ allowed)`,
          },
        ],
        isError: true,
      };
    }

    const fullPath = join(project.root_path, requestedPath);
    const resolvedFull = resolve(fullPath);
    const resolvedRoot = resolve(project.root_path);

    if (
      !resolvedFull.startsWith(resolvedRoot + "/") &&
      resolvedFull !== resolvedRoot
    ) {
      return {
        content: [
          { type: "text", text: `Path traversal blocked: ${params.path}` },
        ],
        isError: true,
      };
    }

    if (!existsSync(fullPath)) {
      return {
        content: [
          {
            type: "text",
            text: `File not found: ${requestedPath} (project: ${params.project})`,
          },
        ],
        isError: true,
      };
    }

    const content = readFileSync(fullPath, "utf8");
    const allLines = content.split("\n");

    const fromLine = (params.from ?? 1) - 1;
    const toLine =
      params.lines != null
        ? Math.min(fromLine + params.lines, allLines.length)
        : allLines.length;

    const selectedLines = allLines.slice(fromLine, toLine);
    const text = selectedLines.join("\n");

    const header =
      params.from != null
        ? `${params.project}/${requestedPath} (lines ${fromLine + 1}-${toLine}):`
        : `${params.project}/${requestedPath}:`;

    return {
      content: [{ type: "text", text: `${header}\n\n${text}` }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Read error: ${String(e)}` }],
      isError: true,
    };
  }
}

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
// Tool: session_list
// ---------------------------------------------------------------------------

export interface SessionListParams {
  project: string;
  limit?: number;
  status?: "open" | "completed" | "compacted";
}

export function toolSessionList(
  registryDb: Database,
  params: SessionListParams
): ToolResult {
  try {
    const projectId = lookupProjectId(registryDb, params.project);
    if (projectId == null) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    const conditions = ["project_id = ?"];
    const queryParams: (string | number)[] = [projectId];

    if (params.status) {
      conditions.push("status = ?");
      queryParams.push(params.status);
    }

    const limit = params.limit ?? 10;
    queryParams.push(limit);

    const sessions = registryDb
      .prepare(
        `SELECT number, date, title, filename, status
         FROM sessions
         WHERE ${conditions.join(" AND ")}
         ORDER BY number DESC
         LIMIT ?`
      )
      .all(...queryParams) as Array<{
      number: number;
      date: string;
      title: string;
      filename: string;
      status: string;
    }>;

    if (sessions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No sessions found for project: ${params.project}`,
          },
        ],
      };
    }

    const lines = sessions.map(
      (s) =>
        `#${String(s.number).padStart(4, "0")}  ${s.date}  [${s.status}]  ${s.title}\n        file: Notes/${s.filename}`
    );

    return {
      content: [
        {
          type: "text",
          text: `${sessions.length} session(s) for ${params.project}:\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `session_list error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: registry_search
// ---------------------------------------------------------------------------

export interface RegistrySearchParams {
  query: string;
}

export function toolRegistrySearch(
  registryDb: Database,
  params: RegistrySearchParams
): ToolResult {
  try {
    const q = `%${params.query}%`;
    const projects = registryDb
      .prepare(
        `SELECT id, slug, display_name, root_path, type, status, updated_at
         FROM projects
         WHERE slug LIKE ?
            OR display_name LIKE ?
            OR root_path LIKE ?
         ORDER BY updated_at DESC
         LIMIT 20`
      )
      .all(q, q, q) as Array<{
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
            text: `No projects found matching: "${params.query}"`,
          },
        ],
      };
    }

    const lines = projects.map((p) => `${p.slug}  [${p.status}]  ${p.root_path}`);

    return {
      content: [
        {
          type: "text",
          text: `${projects.length} match(es) for "${params.query}":\n\n${lines.join("\n")}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [
        { type: "text", text: `registry_search error: ${String(e)}` },
      ],
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
    const { encodeDir: enc } = await import("../cli/utils.js");

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
// Hybrid search helper (backend-agnostic)
// ---------------------------------------------------------------------------

import type { SearchResult } from "../memory/search.js";

/**
 * Combine keyword + semantic results using min-max normalized scoring.
 * Mirrors the logic in searchMemoryHybrid() from memory/search.ts,
 * but works on pre-computed result arrays so it works for any backend.
 */
function combineHybridResults(
  keywordResults: SearchResult[],
  semanticResults: SearchResult[],
  maxResults: number,
  keywordWeight = 0.5,
  semanticWeight = 0.5
): SearchResult[] {
  if (keywordResults.length === 0 && semanticResults.length === 0) return [];

  const keyFor = (r: SearchResult) =>
    `${r.projectId}:${r.path}:${r.startLine}:${r.endLine}`;

  function minMaxNormalize(items: SearchResult[]): Map<string, number> {
    if (items.length === 0) return new Map();
    const min = Math.min(...items.map((r) => r.score));
    const max = Math.max(...items.map((r) => r.score));
    const range = max - min;
    const m = new Map<string, number>();
    for (const r of items) {
      m.set(keyFor(r), range === 0 ? 1 : (r.score - min) / range);
    }
    return m;
  }

  const kwNorm = minMaxNormalize(keywordResults);
  const semNorm = minMaxNormalize(semanticResults);

  const allKeys = new Set<string>([
    ...keywordResults.map(keyFor),
    ...semanticResults.map(keyFor),
  ]);

  const metaMap = new Map<string, SearchResult>();
  for (const r of [...keywordResults, ...semanticResults]) {
    metaMap.set(keyFor(r), r);
  }

  const combined: Array<SearchResult & { combinedScore: number }> = [];
  for (const key of allKeys) {
    const meta = metaMap.get(key)!;
    const kwScore = kwNorm.get(key) ?? 0;
    const semScore = semNorm.get(key) ?? 0;
    const combinedScore = keywordWeight * kwScore + semanticWeight * semScore;
    combined.push({ ...meta, score: combinedScore, combinedScore });
  }

  return combined
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ combinedScore: _unused, ...r }) => r);
}
