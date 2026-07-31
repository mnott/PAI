/**
 * resolver.ts — Ownership resolution for the task bus
 *
 * Maps a tracker task onto the PAI project that owns it.
 *
 *   1. an explicit `pai:<project>` label   (authoritative)
 *   2. the enclosing container name        (fallback, matches the sub-project mirror)
 *   3. otherwise UNROUTED                  (normal state — the findings inbox)
 *
 * Label wins because labels survive a task being moved between containers, and
 * because a task parked in the findings inbox has no meaningful container yet.
 *
 * See Notes/docs/task-bus.md.
 */

import type { Database } from "better-sqlite3";
import {
  OWNER_LABEL_PREFIX,
  UNROUTED,
  type TaskOwner,
} from "./types.js";

// ---------------------------------------------------------------------------
// Alias map
// ---------------------------------------------------------------------------

export interface AliasTarget {
  /** The alias itself — what `pai <name>` and aibroker_pai_launch accept. */
  alias: string;
  slug: string;
  rootPath: string;
}

/** Normalized alias → target. Keys are the output of `normalize()`. */
export type AliasMap = Map<string, AliasTarget>;

/**
 * Fold a tracker-supplied string onto its comparable form.
 *
 * Container names are written for humans and carry decoration the registry
 * never sees: "Reading List 📚", "AcmeAPI", "Client Work". Strip the decoration
 * rather than demanding the user keep two naming schemes in sync.
 *
 * Emoji and pictographs are removed, separators collapse to a single hyphen,
 * and the result is lowercased — so "Client Work" and "client-work" agree.
 */
export function normalize(raw: string): string {
  return raw
    .normalize("NFKD")
    // Drop emoji, pictographs, dingbats and variation selectors.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * Load every alias registered in the PAI registry.
 *
 * Reads the curated shortlist only — the `aliases` table — deliberately. The
 * full registry commonly carries hundreds of projects with no aliases and
 * genuine ambiguity — separate entries routinely share a display name at
 * different paths — so widening this query resolves tasks to the wrong
 * directory. That failure is silent, which makes it worse than no match. Bus
 * participation is opt-in via `pai project name <identifier> <shortname>`.
 */
export function loadAliasMap(db: Database): AliasMap {
  const rows = db
    .prepare(
      `SELECT a.alias    AS alias,
              p.slug     AS slug,
              p.root_path AS rootPath
         FROM aliases a
         JOIN projects p ON p.id = a.project_id
        WHERE p.status != 'archived'`
    )
    .all() as Array<{ alias: string; slug: string; rootPath: string }>;

  const map: AliasMap = new Map();
  for (const row of rows) {
    const target: AliasTarget = {
      alias: row.alias,
      slug: row.slug,
      rootPath: row.rootPath,
    };
    map.set(normalize(row.alias), target);
    // The slug is also addressable, so a task may name either.
    // Aliases win: they are the curated, intentional handle.
    const slugKey = normalize(row.slug);
    if (!map.has(slugKey)) map.set(slugKey, target);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Extract the project named by a `pai:<project>` label, if any. */
export function ownerLabel(labels: string[]): string | null {
  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed.toLowerCase().startsWith(OWNER_LABEL_PREFIX)) {
      const value = trimmed.slice(OWNER_LABEL_PREFIX.length).trim();
      if (value) return value;
    }
  }
  return null;
}

export interface ResolveInput {
  labels: string[];
  /** Name of the enclosing tracker container (sub-project), when there is one. */
  container?: string | null;
}

/**
 * Resolve a task's owner.
 *
 * An unresolvable task is never an error: it returns UNROUTED with `rawHint`
 * set to whatever was tried, so a routine can say *why* it could not route it
 * rather than dropping it silently. A container like "Reading List 📚" maps to
 * no PAI project — that is expected, not a fault.
 */
export function resolveOwner(input: ResolveInput, aliases: AliasMap): TaskOwner {
  const label = ownerLabel(input.labels);
  if (label) {
    const hit = aliases.get(normalize(label));
    if (hit) {
      return {
        project: hit.alias,
        rootPath: hit.rootPath,
        source: "label",
      };
    }
    // An explicit label that resolves to nothing is worth surfacing: the user
    // meant to route this somewhere. Do not silently fall through to the
    // container, which would send it to the wrong project.
    return { ...UNROUTED, rawHint: label };
  }

  if (input.container) {
    const hit = aliases.get(normalize(input.container));
    if (hit) {
      return {
        project: hit.alias,
        rootPath: hit.rootPath,
        source: "container",
      };
    }
    return { ...UNROUTED, rawHint: input.container };
  }

  return { ...UNROUTED };
}
