/**
 * Shared DB helpers, formatting, and path utilities for session sub-commands.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { err } from "../../utils.js";
import type { RegistryBackend } from "../../../storage/registry-interface.js";
import type { SessionRow, ProjectRow } from "./types.js";

export async function getProject(
  registryBackend: RegistryBackend,
  slug: string
): Promise<ProjectRow | undefined> {
  const project = await registryBackend.getProjectBySlug(slug);
  return project ?? undefined;
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "compacted":
      return chalk.blue(status);
    default:
      return chalk.yellow(status);
  }
}

/** Convert a slug to title-cased display name: "memory-engine" → "Memory Engine" */
export function toTitleCase(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Notes directory for a project: ~/.claude/projects/<encoded_dir>/Notes/ */
export function getNotesDir(project: ProjectRow): string {
  return join(homedir(), ".claude", "projects", project.encoded_dir, "Notes");
}

/** Format a session filename: number=27, date="2026-02-23" → "0027 - 2026-02-23 - Title.md" */
export function formatFilename(
  number: number,
  date: string,
  titleSlug: string
): string {
  const n = String(number).padStart(4, "0");
  return `${n} - ${date} - ${titleSlug}.md`;
}

/** Resolve a session by project + number or "latest". Exits on failure. */
export async function resolveSession(
  registryBackend: RegistryBackend,
  project: ProjectRow,
  numberOrLatest: string
): Promise<SessionRow> {
  let session: SessionRow | undefined;

  if (numberOrLatest === "latest") {
    session = (await registryBackend.getLatestSessionForProject(project.id)) ?? undefined;
  } else {
    const num = parseInt(numberOrLatest, 10);
    if (isNaN(num)) {
      console.error(err(`Invalid session number: ${numberOrLatest}`));
      process.exit(1);
    }
    session = (await registryBackend.getSessionByNumber(project.id, num)) ?? undefined;
  }

  if (!session) {
    console.error(
      err(`Session ${numberOrLatest} not found in project ${project.slug}`)
    );
    process.exit(1);
  }

  return session;
}

export async function upsertTag(registryBackend: RegistryBackend, tagName: string): Promise<number> {
  return registryBackend.upsertTag(tagName);
}

export async function getSessionTags(registryBackend: RegistryBackend, sessionId: number): Promise<string[]> {
  return registryBackend.listTagsForSession(sessionId);
}
