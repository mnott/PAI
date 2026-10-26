/**
 * Resolve a session's stored folder when it no longer exists.
 *
 * The picker opens a session in the folder the session record names: the clc
 * registry's literal directory, the PAI registry's root path, or the decoded
 * Claude project dir. Rename a segment of the path — add an emoji, add a sort
 * prefix, move the folder — and all three go stale at once, and `open` answers
 * "the folder no longer exists" for a folder that does exist, just under a new
 * name.
 *
 * Two resolvers, strongest first:
 *   1. the registry's moved-project detection (relocate.ts): walk to the
 *      deepest surviving ancestor, match the remaining segments by normalised
 *      name, accept only a unique match;
 *   2. the same tolerant segment match walked directly from the deepest
 *      surviving ancestor — no registry needed, and it also accepts a renamed
 *      leaf, which relocate declines when the stored path lost a whole segment;
 *   3. the Claude project-dir encoding: every entry under ~/.claude/projects/
 *      decoded the tolerant way, a unique hit whose decoded form matches the
 *      stored path wins.
 *
 * A unique match rebinds the PAI registry row (the same update `pai project
 * rebind` performs) so the next open is direct; several matches get listed for
 * the operator to pick; none keeps today's error, naming the deepest existing
 * ancestor.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { encodeDir, now } from "./utils.js";
import { norm, suggestMovedPath } from "../impl/project/relocate.js";
import { getRegistryBackend } from "../../storage/factory.js";
import type { ProjectRow } from "../impl/project/types.js";

/** What one stored path resolved to. */
export interface FolderResolution {
  /** The folder to open in (realpath), when it was found. */
  dir?: string;
  /** Tolerant-match candidates, when the choice is the operator's. */
  candidates?: string[];
  /** The deepest ancestor of the stored path that still exists. */
  ancestor: string;
  /** Set when a registry row was rebound to `dir`. */
  rebound?: ProjectRow;
}

/**
 * A directory name recognised under both spellings of a sort-prefix rename
 * (`Leaf` <-> `20 - Leaf`): the bare normalised name plus the name with a
 * leading digit run removed. relocate.ts uses the same rule, and for the same
 * reason it is deliberately not a general suffix match — a wanted `Analysis`
 * would silently hit `00 - Migration Analysis`, one hit, uniqueness cannot
 * save it, wrong.
 */
const matchKeys = (name: string): Set<string> => {
  const keys = new Set<string>();
  const bare = norm(name);
  if (bare) keys.add(bare);
  const stripped = norm(name.replace(/^\d+\s*[-._)]?\s*/, ""));
  if (stripped) keys.add(stripped);
  return keys;
};

/** Walk down `path` while it exists; returns the deepest surviving ancestor and the first missing segment. */
function deepestAncestor(path: string): { ancestor: string; rest: string[] } {
  const absolute = path.startsWith(sep);
  const segments = path.split(sep).filter((s) => s.length > 0);
  let current = absolute ? sep : "";
  let i = 0;
  for (; i < segments.length; i++) {
    const next = join(current, segments[i]!);
    if (!existsSync(next)) break;
    current = next;
  }
  return { ancestor: current, rest: segments.slice(i) };
}

/**
 * Directory entries of `dir` recognised as `key` (visible/hidden must match —
 * a leading dot is a category difference, not decoration; `~/PAI` must never
 * "move" to `~/.pai`).
 */
function tolerantChildren(dir: string, key: string, hidden: boolean): string[] {
  if (!key) return [];
  try {
    return readdirSync(dir).filter((name) => {
      if (name.startsWith(".") !== hidden) return false;
      if (!matchKeys(name).has(key)) return false;
      try {
        return existsSync(join(dir, name));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Walk `rest` from `ancestor` through tolerant child matches.
 * A unique hit on every segment resolves; a segment with several hits is
 * reported as `ambiguous` — the parent folder is known, which child the
 * project was is the operator's call.
 */
function walkTolerant(ancestor: string, rest: string[]): { found?: string; ambiguous?: { parent: string; names: string[] } } {
  let current = ancestor;
  for (const segment of rest) {
    const hits = new Set<string>();
    for (const key of matchKeys(segment)) for (const h of tolerantChildren(current, key, segment.startsWith("."))) hits.add(h);
    if (hits.size === 1) {
      current = join(current, [...hits][0]!);
      continue;
    }
    if (hits.size > 1) return { ambiguous: { parent: current, names: [...hits] } };
    return {};
  }
  return current === ancestor ? {} : { found: current };
}

/**
 * (c) Decode a Claude encoded-dir name (e.g. `-Users-u-Vault-Ideaverse-Raspi-Chenarlier`)
 * against the filesystem the tolerant way: one segment run between `-`s at a
 * time (the encoding maps `/`, space, dot, hyphen all to `-`), descending only
 * into a UNIQUE normalised match. Ambiguity at any level declines, same safety
 * rule as relocate.
 */
function decodeEncodedName(encoded: string): string | undefined {
  if (!encoded.startsWith("-")) return undefined;
  let current: string = sep;
  for (const seg of encoded.slice(1).split("-")) {
    const key = norm(seg);
    if (!key) return undefined; // two `-` in a row: no encoded name is empty
    const hits = tolerantChildren(current, key, seg.startsWith("."));
    if (hits.length !== 1) return undefined;
    current = join(current, hits[0]!);
  }
  return current;
}

/** Every ~/.claude/projects/ entry that decodes tolerantly to a unique real folder. */
function decodedClaudeDirs(): string[] {
  const root = join(homedir(), ".claude", "projects");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const decoded = decodeEncodedName(entry);
    if (decoded && existsSync(decoded)) out.push(decoded);
  }
  return out;
}

/** The same update `pai project rebind` makes: new root path + new encoded dir. */
async function rebind(row: ProjectRow, newPath: string): Promise<ProjectRow | undefined> {
  const backend = await getRegistryBackend().catch(() => null);
  if (!backend) return undefined; // best effort: a dead registry must not block opening
  try {
    // the same conflict checks `pai project rebind` makes, by both keys
    const enc = encodeDir(newPath);
    if (await backend.getProjectByRootPath(newPath, { excludeId: row.id })) return undefined;
    if (await backend.getProjectByEncodedDir(enc, { excludeId: row.id })) return undefined;
    await backend.updateProjectPath(row.id, { rootPath: newPath, encodedDir: enc }, now());
    return { ...row, root_path: newPath, encoded_dir: enc };
  } catch {
    return undefined;
  }
}

/**
 * Resolve a session's folder from its stored candidates.
 * `candidates` are the paths the session record carries (clc directory,
 * registry root path, decoded path); `encodedDir` is the session's Claude
 * project-dir name. A candidate that still exists wins outright; otherwise
 * each stored path is resolved in turn — registry move detection, then the
 * tolerant walk, then the Claude encoding — and a renamed leaf found under
 * several candidates is left for the operator to pick.
 */
export async function resolveSessionFolder(
  candidates: readonly (string | undefined)[],
  encodedDir?: string
): Promise<FolderResolution> {
  let last: FolderResolution = { ancestor: sep };
  const ambiguous = new Set<string>();
  let decoded: string[] | undefined; // the Claude-dir scan, at most once per call
  for (const stored of candidates) {
    if (!stored) continue;
    if (existsSync(stored)) return { dir: safeReal(stored), ancestor: safeReal(stored) };
    const { ancestor, rest } = deepestAncestor(stored);
    const hit = async (found: string): Promise<FolderResolution> => {
      const row = await getRegistryBackend()
        .then((b) => b.getProjectByRootPath(stored).catch(() => null))
        .catch(() => null);
      return { dir: safeReal(found), ancestor, ...(row ? { rebound: await rebind(row, found) } : {}) };
    };

    // (a) the registry's moved-project detection (relocate.ts)
    try {
      const backend = await getRegistryBackend();
      const otherRoots = (await backend.listProjects().catch(() => [])).map((p) => p.root_path);
      const moved = suggestMovedPath(stored, otherRoots);
      if (moved) return hit(moved);
    } catch {
      /* no reachable registry — the filesystem resolvers still apply */
    }

    // (b) tolerant segment match against the real directory entries
    const tolerant = walkTolerant(ancestor, rest);
    if (tolerant.found) return hit(tolerant.found);
    if (tolerant.ambiguous) for (const name of tolerant.ambiguous.names) ambiguous.add(join(tolerant.ambiguous.parent, name));

    // (c) the Claude project-dir encoding, decoded the tolerant way
    decoded ??= decodedClaudeDirs();
    const viaClaude = decoded.filter((d) => norm(d) === norm(stored));
    if (viaClaude.length === 1) return hit(viaClaude[0]!);
    if (viaClaude.length > 1) for (const d of viaClaude) ambiguous.add(d);

    last = { ancestor };
  }
  if (ambiguous.size > 1) return { ancestor: last.ancestor, candidates: [...ambiguous] };
  return last;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
