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
  /**
   * Where a task marked only with the bare `pai` marker goes. Omit to leave
   * such a task unrouted, which sends it to the findings inbox for triage.
   */
  defaultOwner?: string | null;
}

/**
 * Does this task carry the bare `pai` marker?
 *
 * The marker means "an AI should take this, and I do not know which one yet" —
 * the single thing a task's location cannot express, and the reason to keep any
 * label mechanism at all. Everything else is answered by the project it sits
 * in, which is single-valued, visible, and changed by the act of moving it.
 *
 * Deliberately distinct from `pai:<name>`: that names a specific owner, this
 * names none. Previously a bare `pai` was a near miss — it looked like an
 * address and resolved to nothing — which meant the most natural thing to type
 * was the one thing that silently did nothing.
 */
export function hasDefaultMarker(labels: string[]): boolean {
  return labels.some((l) => l.trim().toLowerCase() === "pai");
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
  // CONTAINER FIRST. A task sits in exactly one project; it can carry many
  // labels. A multi-valued field cannot be the authoritative owner — with two
  // `pai:` labels there is no principled winner, only whichever the code
  // happens to see first.
  //
  // Labels also survive a move. On 2026-08-02 a task was moved from Clickr to
  // AIBroker in the tracker UI and a comment on it was delivered to Clickr,
  // because a label from its old home outranked the project it now sat in. The
  // user had not seen the label and had not used labels in months. A field
  // nobody is looking at should not outrank the one they just changed
  // deliberately.
  //
  // So: the container decides whenever it resolves. Moving a task is then the
  // whole act of re-assigning it, which is what someone dragging it between
  // projects already believes they are doing.
  if (input.container) {
    const hit = aliases.get(normalize(input.container));
    if (hit) {
      return {
        project: hit.alias,
        rootPath: hit.rootPath,
        source: "container",
      };
    }
  }

  // Labels remain the way to address a task whose container says nothing —
  // sitting in the Inbox, at the bus root, or in a project that mirrors no PAI
  // project. That is the case they are good at, and the only one where nothing
  // else can express the intent.
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
    // An explicit label that resolves to nothing is worth surfacing: someone
    // meant to route this somewhere and named a project that does not exist.
    return { ...UNROUTED, rawHint: label };
  }

  // The bare marker: an AI should take this, nobody said which. Last, because
  // anything more specific is a better answer — this is the Inbox case, where
  // there is no location to read and no owner named.
  if (input.defaultOwner && hasDefaultMarker(input.labels)) {
    const hit = aliases.get(normalize(input.defaultOwner));
    if (hit) {
      return { project: hit.alias, rootPath: hit.rootPath, source: "label" };
    }
    return { ...UNROUTED, rawHint: input.defaultOwner };
  }

  // Container present but unrecognised, and nothing else to go on. Report what
  // was tried — "Reading List 📚" maps to no PAI project, which is expected
  // rather than a fault.
  if (input.container) return { ...UNROUTED, rawHint: input.container };

  return { ...UNROUTED };
}
