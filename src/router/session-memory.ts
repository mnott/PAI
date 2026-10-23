/**
 * session-memory.ts — the cockpit's combined prompt search: recent transcripts first (raw scan of the
 * files modified in the last `router.cockpit.search.recentHours`), PAI's memory index after.
 *
 * The memory index holds session NOTES (source notes / tier session), not raw transcripts, and a chunk
 * carries no session id. A memory hit therefore gets a session id only when the chunk text or path
 * names a transcript that exists (a UUID of a .jsonl under the projects dir); otherwise it is a note
 * hit with an empty id, which the page shows without opening a session.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectsDir } from "../config/pai-home.js";
import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { maskSecrets } from "../hooks/ts/lib/loop-guard.js";
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

export type MemorySearchFn = (q: string, limit: number) => Promise<Omit<MemoryHit, "id" | "turn">[]>;

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
    import("../mcp/tools/memory.js"),
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
  for (const id of new Set(results.map((r) => r.projectId))) {
    const p = await registry.getProjectById(id).catch(() => null);
    if (p) slugs.set(id, p.slug);
  }
  return results.map((r) => ({ path: r.path, projectSlug: slugs.get(r.projectId), snippet: r.snippet, updatedAt: r.updatedAt ?? 0 }));
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("memory search timed out")), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/** Recent transcript hits first, then memory hits not already among them. Never rejects on a memory failure. */
export async function combinedSearch(
  q: string,
  opts: { projectsDir?: string; limit?: number; budgetMs?: number; cancelled?: () => boolean; hours?: number; now?: number; memorySearch?: MemorySearchFn } = {}
): Promise<CombinedSearch> {
  const now = opts.now ?? Date.now();
  const t0 = Date.now();
  const recent = await searchSessions(q, {
    projectsDir: opts.projectsDir,
    limit: opts.limit ?? SESSION_SEARCH_MAX,
    budgetMs: opts.budgetMs,
    cancelled: opts.cancelled,
    sinceMs: now - (opts.hours ?? recentHours()) * 3600_000,
  });
  const recentMs = Date.now() - t0;
  const out: CombinedSearch = { hits: recent.hits.map((h) => ({ ...h, source: "recent" as const })), memory: [], partial: recent.partial, timing: { recentMs, memoryMs: 0 } };
  if (opts.cancelled?.()) return out;
  const t1 = Date.now();
  try {
    const raw = await withTimeout((opts.memorySearch ?? memoryIndexSearch)(q, MEMORY_LIMIT), MEMORY_TIMEOUT_MS);
    const known = transcriptIds(opts.projectsDir ?? claudeProjectsDir());
    const seen = new Set(recent.hits.map((h) => h.id));
    const seenNote = new Set<string>();
    for (const r of raw) {
      const id = (`${r.path}\n${r.snippet}`.match(UUID_G) ?? []).map((u) => u.toLowerCase()).find((u) => known.has(u)) ?? "";
      if (id && seen.has(id)) continue; // same session as a recent hit (those carry one hit per session)
      const key = id || `${r.path}`;
      if (seenNote.has(key)) continue;
      seenNote.add(key);
      out.memory.push({ ...r, id, turn: -1, snippet: maskSecrets(r.snippet.trim()).slice(0, SNIPPET_CHARS), source: "memory" });
    }
  } catch (e) {
    out.note = `memory search unavailable (${(e as Error).message.slice(0, 80)}); showing recent sessions only`;
  }
  out.timing.memoryMs = Date.now() - t1;
  return out;
}
