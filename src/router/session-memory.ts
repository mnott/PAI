/**
 * session-memory.ts — the cockpit's combined prompt search: recent transcripts first (raw scan of the
 * files modified in the last `router.cockpit.search.recentHours`), PAI's memory index after.
 *
 * The memory index holds session NOTES (source notes / tier session), not raw transcripts, and a chunk
 * carries no session id. A memory hit therefore gets a session id only when the chunk text or path
 * names a transcript that exists (a UUID of a .jsonl under the projects dir), or else when the note
 * file's frontmatter `sessions: [...]` lists one (read at query time, so no reindex is needed).
 * Otherwise it is a note hit with an empty id, which the page shows without opening a session.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { claudeProjectsDir } from "../config/pai-home.js";
import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { maskSecrets } from "../hooks/ts/lib/loop-guard.js";
import { parseNoteSessions } from "../session/note-sessions.js";
import { transcriptSpans } from "../session/note-sessions-backfill.js";
import { SESSION_ID_RE, SESSION_SEARCH_MAX, searchSessions, type SessionHit } from "./session-detail.js";

export interface MemoryHit {
  /** transcript session id, "" when the chunk maps to no transcript */
  id: string;
  /** turn index when derivable, else -1 */
  turn: number;
  /** index path of the note the chunk came from */
  path: string;
  projectSlug?: string;
  snippet: string;
  /** epoch ms of the chunk's last update, 0 unknown */
  updatedAt: number;
}

/** A raw memory hit; `roots` are the directories the index path may be relative to (to find the note file). */
export type RawMemoryHit = Omit<MemoryHit, "id" | "turn"> & { roots?: string[] };
export type MemorySearchFn = (q: string, limit: number) => Promise<RawMemoryHit[]>;

export interface CombinedSearch {
  /** recent transcript hits (source "recent") */
  hits: (SessionHit & { source: "recent" })[];
  memory: (MemoryHit & { source: "memory" })[];
  /** true when the recent scan was stopped early */
  partial: boolean;
  /** one line when the memory part is unavailable */
  note?: string;
  timing: { recentMs: number; memoryMs: number };
}

export const DEFAULT_RECENT_HOURS = 48;
const MEMORY_LIMIT = 20;
const MEMORY_TIMEOUT_MS = 6000;
const SNIPPET_CHARS = 200;

/** router.cockpit.search.recentHours from the effective main config (shipped default 48). */
export function recentHours(): number {
  try {
    const r = effectiveMainConfig(paiConfigFilePath()).router as Record<string, any> | undefined;
    const h = Number(r?.cockpit?.search?.recentHours);
    return Number.isFinite(h) && h > 0 ? h : DEFAULT_RECENT_HOURS;
  } catch {
    return DEFAULT_RECENT_HOURS;
  }
}

/** The daemon/MCP memory_search path run in-process: the configured mode (keyword | semantic | hybrid), session notes only. */
export const memoryIndexSearch: MemorySearchFn = async (q, limit) => {
  const [{ getStorageBackend }, { loadConfig }, { embedQuery }, { combineHybridResults }] = await Promise.all([
    import("../storage/factory.js"),
    import("../daemon/config.js"),
    import("../memory/embedding-gate.js"),
    import("../memory/search.js"),
  ]);
  const search = loadConfig().search;
  const backend = await getStorageBackend();
  const opts = { sources: ["notes"], tiers: ["session"], maxResults: limit };
  let results = await backend.searchKeyword(q, opts);
  if (search.mode !== "keyword") {
    const e = await embedQuery(backend, q);
    if (e.vec) {
      if (search.mode === "semantic") results = await backend.searchSemantic(e.vec, opts);
      else {
        const [kw, sem] = await Promise.all([
          backend.searchKeyword(q, { ...opts, maxResults: 50 }),
          backend.searchSemantic(e.vec, { ...opts, maxResults: 50 }),
        ]);
        results = combineHybridResults(kw, sem, limit);
      }
    }
  }
  const registry = await (await import("../storage/factory.js")).getRegistryBackend();
  const slugs = new Map<number, string>();
  const roots = new Map<number, string[]>();
  for (const id of new Set(results.map((r) => r.projectId))) {
    const p = await registry.getProjectById(id).catch(() => null);
    if (!p) continue;
    slugs.set(id, p.slug);
    roots.set(id, [p.root_path, join(claudeProjectsDir(), p.encoded_dir), ...(p.claude_notes_dir ? [p.claude_notes_dir, join(p.claude_notes_dir, "..")] : [])]);
  }
  return results.map((r) => ({ path: r.path, projectSlug: slugs.get(r.projectId), snippet: r.snippet, updatedAt: r.updatedAt ?? 0, roots: roots.get(r.projectId) }));
};

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function transcriptIds(projectsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(projectsDir)) return ids;
  for (const d of readdirSync(projectsDir)) {
    try {
      for (const n of readdirSync(join(projectsDir, d))) if (n.endsWith(".jsonl") && SESSION_ID_RE.test(n.slice(0, -6))) ids.add(n.slice(0, -6));
    } catch {
      /* not a directory */
    }
  }
  return ids;
}

const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * The session a note hit most likely belongs to, from the `sessions:` frontmatter of its note file:
 * the only one; else the one whose transcript time range contains the nearest checkpoint stamp at or
 * before the snippet in the note body; else the latest recorded. "" when the note has none.
 */
export async function noteHitSession(hit: RawMemoryHit, projectsDir: string, known: Set<string>): Promise<string> {
  const file = isAbsolute(hit.path) ? [hit.path] : (hit.roots ?? []).map((r) => join(r, hit.path));
  for (const f of file) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const ids = parseNoteSessions(text).filter((i) => known.has(i));
    if (ids.length <= 1) return ids[0] ?? "";
    const probe = hit.snippet.replace(/\s+/g, " ").trim().slice(0, 40);
    const at = probe ? text.replace(/\s+/g, " ").indexOf(probe) : -1;
    if (at >= 0) {
      const before = text.replace(/\s+/g, " ").slice(0, at).match(STAMP);
      const t = before ? Date.parse(before[before.length - 1]) : NaN;
      if (Number.isFinite(t)) {
        let dir: string | undefined;
        for (const d of readdirSync(projectsDir)) if (existsSync(join(projectsDir, d, `${ids[0]}.jsonl`))) dir = join(projectsDir, d);
        const spans = dir ? await transcriptSpans(dir) : [];
        const inside = ids.filter((i) => spans.some((s) => s.id === i && t >= s.startMs && t <= s.endMs));
        if (inside.length) return inside[inside.length - 1];
      }
    }
    return ids[ids.length - 1];
  }
  return "";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("memory search timed out")), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/** Recent transcript hits first, then memory hits not already among them. Never rejects on a memory failure. */
export async function combinedSearch(
  q: string,
  opts: { projectsDir?: string; limit?: number; budgetMs?: number; cancelled?: () => boolean; hours?: number; now?: number; memorySearch?: MemorySearchFn; /** the operator's hide rules for the search list */ hidden?: (text: string) => boolean } = {}
): Promise<CombinedSearch> {
  const now = opts.now ?? Date.now();
  const t0 = Date.now();
  const recent = await searchSessions(q, {
    projectsDir: opts.projectsDir,
    limit: opts.limit ?? SESSION_SEARCH_MAX,
    budgetMs: opts.budgetMs,
    cancelled: opts.cancelled,
    sinceMs: now - (opts.hours ?? recentHours()) * 3600_000,
    skip: opts.hidden,
  });
  const recentMs = Date.now() - t0;
  const out: CombinedSearch = { hits: recent.hits.map((h) => ({ ...h, source: "recent" as const })), memory: [], partial: recent.partial, timing: { recentMs, memoryMs: 0 } };
  if (opts.cancelled?.()) return out;
  const t1 = Date.now();
  try {
    const raw = await withTimeout((opts.memorySearch ?? memoryIndexSearch)(q, MEMORY_LIMIT), MEMORY_TIMEOUT_MS);
    const projectsDir = opts.projectsDir ?? claudeProjectsDir();
    const known = transcriptIds(projectsDir);
    const seen = new Set(recent.hits.map((h) => h.id));
    const seenNote = new Set<string>();
    for (const r of raw) {
      if (opts.hidden?.(r.snippet)) continue;
      const id =
        (`${r.path}\n${r.snippet}`.match(UUID_G) ?? []).map((u) => u.toLowerCase()).find((u) => known.has(u)) ??
        (await noteHitSession(r, projectsDir, known).catch(() => ""));
      if (id && seen.has(id)) continue; // same session as a recent hit (those carry one hit per session)
      const key = id || `${r.path}`;
      if (seenNote.has(key)) continue;
      seenNote.add(key);
      const { roots: _roots, ...rest } = r;
      out.memory.push({ ...rest, id, turn: -1, snippet: maskSecrets(r.snippet.trim()).slice(0, SNIPPET_CHARS), source: "memory" });
    }
  } catch (e) {
    out.note = `memory search unavailable (${(e as Error).message.slice(0, 80)}); showing recent sessions only`;
  }
  out.timing.memoryMs = Date.now() - t1;
  return out;
}
