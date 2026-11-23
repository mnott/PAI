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
 * See docs/task-bus.md.
 */

import { getRegistryBackend } from "../storage/factory.js";
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

/**
 * Everything an owner name can be matched against: registry projects (slug,
 * alias, display name) and live session names. One index, one lookup
 * (`lookupOwner`) for the poller, dispatch, listing and `--owner`.
 */
export interface OwnerIndex {
  projects: OwnerCandidateSource[];
  sessions: OwnerSession[];
}
export type AliasMap = OwnerIndex;

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

export interface OwnerCandidateSource {
  alias?: string;
  slug: string;
  displayName?: string;
  rootPath: string;
}

export interface OwnerSession {
  name: string;
  directory: string;
}

export type OwnerLookup =
  | { kind: "match"; target: AliasTarget }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none"; suggestions: string[] };

/** "pai-2" -> "pai". Only the registry's numeric dedupe suffix. */
function stripDedupe(key: string): string {
  return key.replace(/-\d+$/, "");
}

/**
 * Resolve an owner string against projects (slug, alias, display name) and
 * live session names (mapped to a project by cwd).
 *
 * Tiers, first non-empty wins: exact alias/slug (normalized), then display
 * name or session name, then the same with the numeric dedupe suffix stripped
 * from the slug. A tier hitting two different root paths is ambiguous.
 */
export function lookupOwner(
  name: string,
  projects: OwnerCandidateSource[],
  sessions: OwnerSession[] = []
): OwnerLookup {
  const key = normalize(name);
  const byRoot = new Map<string, OwnerCandidateSource>();
  for (const p of projects) if (!byRoot.has(p.rootPath)) byRoot.set(p.rootPath, p);
  const keyed: Array<{ tier: number; key: string; p: OwnerCandidateSource }> = [];
  for (const p of projects) {
    if (p.alias) keyed.push({ tier: 0, key: normalize(p.alias), p });
    keyed.push({ tier: 0, key: normalize(p.slug), p });
    if (p.displayName) keyed.push({ tier: 1, key: normalize(p.displayName), p });
    keyed.push({ tier: 2, key: stripDedupe(normalize(p.slug)), p });
  }
  for (const s of sessions) {
    const p = byRoot.get(s.directory);
    if (p) keyed.push({ tier: 1, key: normalize(s.name), p });
  }
  const toTarget = (p: OwnerCandidateSource): AliasTarget => ({
    alias: p.alias ?? p.slug,
    slug: p.slug,
    rootPath: p.rootPath,
  });
  const queryKeys = [key];
  const stripped = stripDedupe(key);
  if (stripped !== key) queryKeys.push(stripped);
  for (const tier of [0, 1, 2]) {
    for (const qk of queryKeys) {
      const hits = keyed.filter((k) => k.tier === tier && k.key === qk);
      const roots = new Map(hits.map((h) => [h.p.rootPath, h.p]));
      if (roots.size === 1) return { kind: "match", target: toTarget([...roots.values()][0]) };
      if (roots.size > 1) {
        return { kind: "ambiguous", candidates: [...roots.values()].map((p) => `${p.slug} (${p.rootPath})`) };
      }
    }
  }
  const names = new Set<string>();
  for (const k of keyed) if (k.tier < 2) names.add(k.key);
  const suggestions = [...names]
    .filter((n) => n && (n.includes(key) || key.includes(n) || n[0] === key[0]))
    .sort()
    .slice(0, 5);
  return { kind: "none", suggestions };
}

/** Human-readable error for a non-matching lookup, or null on a match. */
export function describeOwnerLookup(name: string, r: OwnerLookup): string | null {
  if (r.kind === "match") return null;
  if (r.kind === "ambiguous") return `owner "${name}" is ambiguous: ${r.candidates.join(", ")}`;
  return `owner "${name}" matches no project` + (r.suggestions.length ? `; closest: ${r.suggestions.join(", ")}` : "");
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
export async function loadAliasMap(sessions: OwnerSession[] = []): Promise<AliasMap> {
  const registry = await getRegistryBackend();
  const aliasRows = await registry.listAliasMap();
  const projects: OwnerCandidateSource[] = [];
  for (const p of await registry.listProjects()) {
    if (p.status === "archived") continue;
    projects.push({ slug: p.slug, displayName: p.display_name, rootPath: p.root_path });
  }
  for (const r of aliasRows) projects.push({ alias: r.alias, slug: r.slug, rootPath: r.root_path });
  return { projects, sessions };
}

/**
 * Forgiving owner lookup for an explicit owner name (`--owner`): registry
 * projects (slug, display name), aliases, and live session names.
 * Unambiguous or an explanatory error.
 */
export async function lookupOwnerName(
  name: string,
  sessions: OwnerSession[] = []
): Promise<OwnerLookup> {
  const index = await loadAliasMap(sessions);
  return lookupOwner(name, index.projects, index.sessions);
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

/** Single owner decision: a unique match or null (unknown and ambiguous alike). */
function findTarget(index: AliasMap, name: string): AliasTarget | null {
  const r = lookupOwner(name, index.projects, index.sessions);
  return r.kind === "match" ? r.target : null;
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
  // Labels also survive a move. On 2026-08-02 a task was moved from SampleTool to
  // AIBroker in the tracker UI and a comment on it was delivered to SampleTool,
  // because a label from its old home outranked the project it now sat in. The
  // user had not seen the label and had not used labels in months. A field
  // nobody is looking at should not outrank the one they just changed
  // deliberately.
  //
  // So: the container decides whenever it resolves. Moving a task is then the
  // whole act of re-assigning it, which is what someone dragging it between
  // projects already believes they are doing.
  if (input.container) {
    const hit = findTarget(aliases, input.container);
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
    const hit = findTarget(aliases, label);
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
    const hit = findTarget(aliases, input.defaultOwner);
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
