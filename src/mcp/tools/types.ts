/**
 * Shared types and project-row helpers used across all MCP tool handler modules.
 */

import { resolve } from "node:path";
import type { RegistryBackend, Project } from "../../storage/registry-interface.js";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Shared row type — mirrors the projects schema (RegistryBackend's Project)
// ---------------------------------------------------------------------------

export type ProjectRow = Project;

// ---------------------------------------------------------------------------
// Helper: lookup project_id by slug (also checks aliases)
// ---------------------------------------------------------------------------

export async function lookupProjectId(
  registry: RegistryBackend,
  slug: string
): Promise<number | null> {
  const bySlug = await registry.getProjectBySlug(slug);
  if (bySlug) return bySlug.id;

  const projectId = await registry.resolveAlias(slug);
  return projectId ?? null;
}

// ---------------------------------------------------------------------------
// Helper: detect project from a filesystem path
// ---------------------------------------------------------------------------

export async function detectProjectFromPath(
  registry: RegistryBackend,
  fsPath: string
): Promise<ProjectRow | null> {
  const resolved = resolve(fsPath);

  const exact = await registry.getProjectByRootPath(resolved);
  if (exact) return exact;

  const all = await registry.listProjectsByPathLengthDesc();

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

export async function formatProject(registry: RegistryBackend, project: ProjectRow): Promise<string> {
  const sessionCount = await registry.countSessionsForProject(project.id);
  const lastSessionDate = await registry.getMostRecentSessionDate(project.id);
  const tags = await registry.listTagsForProject(project.id);
  const aliases = await registry.listAliasesForProject(project.id);

  const lines: string[] = [
    `slug: ${project.slug}`,
    `display_name: ${project.display_name}`,
    `root_path: ${project.root_path}`,
    `type: ${project.type}`,
    `status: ${project.status}`,
    `sessions: ${sessionCount}`,
  ];

  if (lastSessionDate) lines.push(`last_session: ${lastSessionDate}`);
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
