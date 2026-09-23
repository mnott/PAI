/**
 * Shared registry helper functions for project sub-commands.
 * Each function asks the process-wide RegistryBackend itself rather than
 * taking a database handle — callers just `await` them.
 */

import { getRegistryBackend } from "../../../storage/factory.js";
import type { ProjectRow } from "./types.js";

/**
 * Find a project by slug or alias, case-insensitively.
 *
 * Slugs are conventionally lowercase, so exact matching went unnoticed until a
 * project was deliberately named `Solar` — after which `pai project info solar`
 * reported "Project not found" for a project sitting right there. Nobody types
 * a name back with its capitalisation intact, and a lookup that demands it will
 * be wrong more often than the user is.
 *
 * Exact match is still tried first: where two projects differ only by case, the
 * one asked for by its exact name wins rather than whichever the database
 * returns first.
 */
export async function getProject(slug: string): Promise<ProjectRow | undefined> {
  const backend = await getRegistryBackend();

  const direct = await backend.getProjectBySlug(slug);
  if (direct) return direct;

  const alias = await backend.getProjectByAlias(slug);
  if (alias) return alias;

  const insensitive = await backend.getProjectBySlug(slug, { caseInsensitive: true });
  if (insensitive) return insensitive;

  const aliasInsensitive = await backend.getProjectByAlias(slug, { caseInsensitive: true });
  return aliasInsensitive ?? undefined;
}

export async function requireProject(slug: string): Promise<ProjectRow> {
  const project = await getProject(slug);
  if (!project) {
    // Throw rather than process.exit(1): it propagates to the top-level
    // catch in cli/index.ts, which prints the message and sets
    // process.exitCode, letting the process exit naturally so piped
    // stdout/stderr is flushed (process.exit() does not guarantee that).
    throw new Error(`Project not found: ${slug}`);
  }
  return project;
}

/**
 * Resolve an identifier that may be a list index number or a slug.
 */
export async function resolveIdentifier(identifier: string): Promise<ProjectRow | undefined> {
  const num = parseInt(identifier, 10);
  if (!isNaN(num) && num > 0 && String(num) === identifier) {
    const backend = await getRegistryBackend();
    const rows = await backend.listProjects({ orderBy: "status_updated" });
    if (num <= rows.length) return rows[num - 1];
  }
  return getProject(identifier);
}

export async function getProjectTags(projectId: number): Promise<string[]> {
  const backend = await getRegistryBackend();
  return backend.listTagsForProject(projectId);
}

export async function getProjectAliases(projectId: number): Promise<string[]> {
  const backend = await getRegistryBackend();
  return backend.listAliasesForProject(projectId);
}

export async function getSessionCount(projectId: number): Promise<number> {
  const backend = await getRegistryBackend();
  return backend.countSessionsForProject(projectId);
}

export async function getLastSessionDate(projectId: number): Promise<number | null> {
  const backend = await getRegistryBackend();
  const sessions = await backend.listSessionsForProject(projectId, { orderBy: "created_desc", limit: 1 });
  return sessions[0]?.created_at ?? null;
}

export async function upsertTag(tagName: string): Promise<number> {
  const backend = await getRegistryBackend();
  return backend.upsertTag(tagName);
}
