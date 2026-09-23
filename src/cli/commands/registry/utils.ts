/** Shared registry helpers for registry command operations. */

import type { RegistryBackend } from "../../../storage/registry-interface.js";
import { now } from "../../utils.js";
import { basename, join } from "node:path";
import { transcriptFiles, claudeProjectsDir } from "../../../registry/moved.js";

/**
 * Would writing this encoded_dir replace a working one with a broken one?
 *
 * `encodeDir` is lossy: `~` and emoji do not survive it, so a value derived
 * from a project's path can name a folder Claude Code never created. Every
 * caller here derives its value that way, and this function is the single
 * point they all pass through.
 *
 * `pai registry reconnect` repairs those by reading the cwd recorded inside the
 * transcripts. Without this check the next scan silently reverts the repair —
 * and it reverts it in the most confusing possible way, because a read taken
 * straight after the repair still shows it. Observed twice on 2026-08-02:
 * three projects reconnected, verified, and rediscovered as broken within the
 * hour, with the repair command reporting success both times.
 *
 * Permits the write when the new value resolves to transcripts, or when the
 * existing one resolves to nothing — i.e. whenever it cannot make things worse.
 */
async function worthWriting(backend: RegistryBackend, projectId: number, encodedDir: string): Promise<boolean> {
  if (transcriptFiles(join(claudeProjectsDir(), encodedDir)).length > 0) return true;

  const project = await backend.getProjectById(projectId);
  const current = project?.encoded_dir;
  if (!current) return true;

  return transcriptFiles(join(claudeProjectsDir(), current)).length === 0;
}

/**
 * Upsert a project row. Returns { id, isNew }.
 *
 * Matching priority:
 *  1. root_path  — most reliable; handles slug collisions
 *  2. encoded_dir — Claude project dirs are canonical
 *  3. Insert with suffix-deduplication on slug collision
 *
 * display_name is set to basename(rootPath) on INSERT so that the unified
 * listing always shows a human-readable name rather than the kebab-case slug.
 */
export async function upsertProject(
  backend: RegistryBackend,
  slug: string,
  rootPath: string,
  encodedDir: string
): Promise<{ id: number; isNew: boolean }> {
  const ts = now();

  const byPath = await backend.getProjectByRootPath(rootPath);

  if (byPath) {
    const encodedOwner = await backend.getProjectByEncodedDir(encodedDir);

    if (
      (!encodedOwner || encodedOwner.id === byPath.id) &&
      (await worthWriting(backend, byPath.id, encodedDir))
    ) {
      await backend.updateProjectPath(byPath.id, { encodedDir }, ts);
    }
    return { id: byPath.id, isNew: false };
  }

  const byEncoded = await backend.getProjectByEncodedDir(encodedDir);

  if (byEncoded) {
    const pathOwner = await backend.getProjectByRootPath(rootPath);

    if (!pathOwner || pathOwner.id === byEncoded.id) {
      await backend.updateProjectPath(byEncoded.id, { rootPath }, ts);
    }
    return { id: byEncoded.id, isNew: false };
  }

  // Use basename(rootPath) as the human display name. If rootPath is empty or
  // just "/" fall back to the slug so we always have something non-empty.
  const displayName = basename(rootPath) || slug;

  const result = await backend.createProjectWithSlugRetry({
    baseSlug: slug,
    displayName,
    rootPath,
    encodedDir,
    createdAt: ts,
    updatedAt: ts,
  });

  return { id: result.id, isNew: result.created };
}

/** Upsert a session note. Returns true if newly inserted. */
export async function upsertSession(
  backend: RegistryBackend,
  projectId: number,
  number: number,
  date: string,
  slug: string,
  title: string,
  filename: string
): Promise<boolean> {
  return backend.upsertSessionIfAbsent({
    projectId,
    number,
    date,
    slug,
    title,
    filename,
    createdAt: now(),
  });
}
