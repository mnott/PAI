/**
 * Public code-graph API — the stable surface CLI/MCP tools build on.
 *
 * Every query function runs ensureFresh() first so answers never come from a
 * stale index: lazy full index on first sight of a repo, then a cheap
 * mtime→hash reconcile per call (ponytail: a watcher daemon would replace it).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StorageBackend } from "../storage/interface.js";
import type { CodeGraphStore, SymbolRow } from "./store.js";
import { indexRoot, reconcile } from "./indexer.js";

export interface IndexStats {
  root: string;
  backend: "postgres" | "sqlite";
  files: number;
  symbols: number;
  refs: number;
  resolvedRefs: number;
  changed: number;
  deleted: number;
  ms: number;
}

export interface SymbolHit {
  id: number;
  name: string;
  qualifiedName: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
}

export interface RefHit {
  symbol: SymbolHit | null;
  name: string;
  kind: string;
  file: string;
  line: number;
}

function toHit(s: SymbolRow): SymbolHit {
  return {
    id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind,
    file: s.file, startLine: s.startLine, endLine: s.endLine,
    signature: s.signature, exported: s.exported,
  };
}

/** git toplevel of cwd (default process.cwd()), else cwd itself */
export function resolveRoot(cwd?: string): string {
  const start = resolve(cwd ?? process.cwd());
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" }).trim();
    if (out) return resolve(out);
  } catch {
    /* not a git repo */
  }
  return start;
}

/** Full (incremental) index of a repo. */
export async function indexRepo(backend: StorageBackend, root: string, opts?: { force?: boolean }): Promise<IndexStats> {
  const t0 = Date.now();
  const store = backend.codeGraph();
  const rootAbs = resolve(root);
  const counts = await indexRoot(store, rootAbs, opts);
  const stats = await store.stats(rootAbs);
  return {
    root: rootAbs,
    backend: backend.backendType,
    files: stats.files,
    symbols: stats.symbols,
    refs: stats.refs,
    resolvedRefs: stats.resolvedRefs,
    changed: counts.changed,
    deleted: counts.deleted,
    ms: Date.now() - t0,
  };
}

/** Lazy full index when the repo was never indexed; else a cheap reconcile. Null when nothing changed. */
export async function ensureFresh(backend: StorageBackend, root: string): Promise<IndexStats | null> {
  const store = backend.codeGraph();
  const rootAbs = resolve(root);
  const t0 = Date.now();
  const existing = await store.stats(rootAbs);
  if (existing.files === 0) {
    return indexRepo(backend, rootAbs);
  }
  const counts = await reconcile(store, rootAbs);
  if (!counts) return null;
  const stats = await store.stats(rootAbs);
  return {
    root: rootAbs,
    backend: backend.backendType,
    files: stats.files,
    symbols: stats.symbols,
    refs: stats.refs,
    resolvedRefs: stats.resolvedRefs,
    changed: counts.changed,
    deleted: counts.deleted,
    ms: Date.now() - t0,
  };
}

export async function status(backend: StorageBackend, root: string): Promise<{
  root: string; backend: string; indexed: boolean; files: number; symbols: number;
  refs: number; resolvedRefs: number; byLanguage: Record<string, number>; lastIndexedAt: string | null;
}> {
  const store = backend.codeGraph();
  const rootAbs = resolve(root);
  const s = await store.stats(rootAbs);
  return {
    root: rootAbs,
    backend: backend.backendType,
    indexed: s.files > 0,
    files: s.files,
    symbols: s.symbols,
    refs: s.refs,
    resolvedRefs: s.resolvedRefs,
    byLanguage: s.byLanguage,
    lastIndexedAt: s.lastIndexedAt != null ? new Date(s.lastIndexedAt).toISOString() : null,
  };
}

export async function searchSymbols(backend: StorageBackend, root: string, query: string, limit?: number): Promise<SymbolHit[]> {
  await ensureFresh(backend, root);
  const rows = await backend.codeGraph().searchSymbols(resolve(root), query, limit ?? 20);
  return rows.map(toHit);
}

export async function callers(backend: StorageBackend, root: string, name: string, limit?: number): Promise<RefHit[]> {
  await ensureFresh(backend, root);
  const store = backend.codeGraph();
  const rootAbs = resolve(root);
  // refs pointing at the symbol(s) with this name — resolved ones by id, bare-name ones too
  const targets = await store.symbolsByName(rootAbs, name, 20);
  const seen = new Set<string>();
  const out: RefHit[] = [];
  for (const t of targets) {
    for (const r of await store.callers(t.id)) {
      if (r.fromFile === t.file && r.kind === "references" && Math.abs(r.line - t.startLine) <= 1) continue; // the definition itself
      const key = `${r.fromFile}:${r.line}:${r.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ symbol: toHit(t), name: r.toName, kind: r.kind, file: r.fromFile, line: r.line });
      if (out.length >= (limit ?? 50)) return out;
    }
  }
  // unresolved refs by bare name still count as call-sites of that name
  for (const r of await store.callersByName(rootAbs, name, limit ?? 50)) {
    if (r.target) continue; // already covered via symbol ids above
    const key = `${r.fromFile}:${r.line}:${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: null, name: r.toName, kind: r.kind, file: r.fromFile, line: r.line });
    if (out.length >= (limit ?? 50)) break;
  }
  return out;
}

export async function callees(backend: StorageBackend, root: string, name: string, limit?: number): Promise<RefHit[]> {
  await ensureFresh(backend, root);
  const store = backend.codeGraph();
  const rootAbs = resolve(root);
  const targets = await store.symbolsByName(rootAbs, name, 20);
  const seen = new Set<string>();
  const out: RefHit[] = [];
  for (const t of targets) {
    for (const r of await store.callees(t.id)) {
      const key = `${r.fromFile}:${r.line}:${r.toName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ symbol: r.target ? toHit(r.target) : null, name: r.toName, kind: r.kind, file: r.fromFile, line: r.line });
      if (out.length >= (limit ?? 50)) return out;
    }
  }
  return out;
}

/** Transitive dependents of the symbol `name` up to `depth` hops. */
export async function impact(backend: StorageBackend, root: string, name: string, depth = 2): Promise<{ files: string[]; symbols: SymbolHit[] }> {
  await ensureFresh(backend, root);
  const store = backend.codeGraph();
  const rootAbs = resolve(root);

  const seeds = await store.symbolsByName(rootAbs, name, 20);
  if (seeds.length === 0) return { files: [], symbols: [] };

  let frontierFiles = [...new Set(seeds.map((s) => s.file))];
  const visitedFiles = new Set(frontierFiles);
  const dependentSymbols = new Map<number, SymbolRow>();

  for (let hop = 0; hop < depth; hop++) {
    const edges = await store.refsToFiles(rootAbs, frontierFiles);
    const nextFiles: string[] = [];
    for (const e of edges) {
      if (!visitedFiles.has(e.fromFile)) { visitedFiles.add(e.fromFile); nextFiles.push(e.fromFile); }
    }
    // symbols in the dependent files that actually reference the frontier
    for (const f of nextFiles.length ? nextFiles : []) {
      for (const s of await store.symbolsInFile(rootAbs, f)) dependentSymbols.set(s.id, s);
    }
    if (nextFiles.length === 0) break;
    frontierFiles = nextFiles;
  }

  return { files: [...visitedFiles].sort(), symbols: [...dependentSymbols.values()].map(toHit) };
}

export interface ExploreResult {
  text: string;
  symbols: SymbolHit[];
  truncated: boolean;
}

/** identifier-like tokens from a question or symbol list */
function queryTokens(query: string): string[] {
  return [...new Set(query.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? [])];
}

/** verbatim source of a symbol, read from disk by line range */
function sourceOf(rootAbs: string, s: SymbolHit): string {
  try {
    const lines = readFileSync(`${rootAbs}/${s.file}`, "utf8").split("\n");
    return lines.slice(s.startLine - 1, Math.min(s.endLine, s.startLine + 40)).join("\n");
  } catch {
    return s.signature;
  }
}

/**
 * explore(): a question or symbol names in, a bounded briefing out.
 * Exact-name matches first, then FTS; grouped by file with verbatim source,
 * one hop of callers/callees (depth for more), and a blast-radius summary.
 * Hard-bounded by budgetTokens (~4 chars/token); truncated when cut.
 */
export async function explore(
  backend: StorageBackend,
  root: string,
  query: string,
  opts?: { budgetTokens?: number; depth?: number },
): Promise<ExploreResult> {
  await ensureFresh(backend, root);
  const store = backend.codeGraph();
  const rootAbs = resolve(root);
  const budgetChars = (opts?.budgetTokens ?? 4000) * 4;
  const depth = opts?.depth ?? 1;

  // exact-name matches first, then full-text
  const tokens = queryTokens(query);
  const matched = new Map<number, SymbolHit>();
  for (const t of tokens) {
    for (const s of await store.symbolsByName(rootAbs, t, 5)) if (!matched.has(s.id)) matched.set(s.id, toHit(s));
    // qualified tail match: "preempt.otherUrgent" style
    for (const s of await store.searchSymbols(rootAbs, t, 3)) if (!matched.has(s.id)) matched.set(s.id, toHit(s));
    if (matched.size >= 12) break;
  }
  const symbols = [...matched.values()];

  let text = "";
  let truncated = false;
  const push = (chunk: string): boolean => {
    if (text.length + chunk.length > budgetChars) {
      const room = budgetChars - text.length;
      if (room > 80) text += `${chunk.slice(0, room)}\n…`;
      truncated = true;
      return false;
    }
    text += chunk;
    return true;
  };

  push(`# ${query}\n`);

  // definitions grouped by file
  const byFile = new Map<string, SymbolHit[]>();
  for (const s of symbols) {
    let list = byFile.get(s.file);
    if (!list) { list = []; byFile.set(s.file, list); }
    list.push(s);
  }
  for (const [file, syms] of byFile) {
    if (!push(`\n## ${file}\n`)) break;
    for (const s of syms) {
      const body = sourceOf(rootAbs, s);
      if (!push(`### ${s.qualifiedName} (${s.kind}${s.exported ? ", exported" : ""}) L${s.startLine}-${s.endLine}\n\`\`\`\n${body}\n\`\`\`\n`)) break;
    }
  }

  // one hop (or depth hops) of callers/callees around the seed symbols
  if (!truncated) {
    push(`\n## Callers\n`);
    for (const s of symbols.slice(0, 6)) {
      const hits = await callersNoFresh(backend, rootAbs, s.name, 8);
      for (const h of hits) {
        if (h.file === s.file && Math.abs(h.line - s.startLine) <= 1) continue;
        if (!push(`- ${s.qualifiedName} ← ${h.file}:${h.line} (${h.kind})\n`)) break;
      }
    }
    push(`\n## Callees\n`);
    for (const s of symbols.slice(0, 6)) {
      const hits = await calleesNoFresh(backend, rootAbs, s.qualifiedName, 8);
      for (const h of hits) if (!push(`- ${s.qualifiedName} → ${h.name} (${h.kind}) at ${h.file}:${h.line}\n`)) break;
    }
    // deeper hops: dependents beyond the first ring
    if (depth > 1 && !truncated) {
      for (const s of symbols.slice(0, 3)) {
        const imp = await impactNoFresh(backend, rootAbs, s.name, depth);
        const extra = imp.files.filter((f) => !byFile.has(f));
        if (extra.length) push(`\n## Blast radius (${s.name}, depth ${depth})\n${extra.map((f) => `- ${f}`).join("\n")}\n`);
      }
    }
  }

  // blast-radius summary for the seed symbols themselves
  if (!truncated && symbols.length) {
    const imp = await impactNoFresh(backend, rootAbs, symbols[0].name, Math.max(1, depth));
    const depFiles = imp.files.filter((f) => !byFile.has(f));
    push(`\n## Blast radius\n${depFiles.length} dependent file(s): ${depFiles.slice(0, 20).join(", ") || "none"}\n`);
    if (imp.symbols.length) push(`${imp.symbols.length} dependent symbol(s).\n`);
  }

  return { text, symbols, truncated };
}

// internal variants that skip the ensureFresh round-trip (explore already refreshed)
async function callersNoFresh(backend: StorageBackend, rootAbs: string, name: string, limit: number): Promise<RefHit[]> {
  return callersFromStore(backend.codeGraph(), rootAbs, name, limit);
}
async function calleesNoFresh(backend: StorageBackend, rootAbs: string, qualifiedName: string, limit: number): Promise<RefHit[]> {
  const store = backend.codeGraph();
  const out: RefHit[] = [];
  for (const r of await store.calleesByName(rootAbs, qualifiedName, limit)) {
    out.push({ symbol: r.target ? toHit(r.target) : null, name: r.toName, kind: r.kind, file: r.fromFile, line: r.line });
  }
  return out;
}

async function callersFromStore(store: CodeGraphStore, rootAbs: string, name: string, limit: number): Promise<RefHit[]> {
  const targets = await store.symbolsByName(rootAbs, name, 20);
  const seen = new Set<string>();
  const out: RefHit[] = [];
  for (const t of targets) {
    for (const r of await store.callers(t.id)) {
      const key = `${r.fromFile}:${r.line}:${r.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ symbol: toHit(t), name: r.toName, kind: r.kind, file: r.fromFile, line: r.line });
      if (out.length >= limit) return out;
    }
  }
  for (const r of await store.callersByName(rootAbs, name, limit)) {
    if (r.target) continue;
    const key = `${r.fromFile}:${r.line}:${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: null, name: r.toName, kind: r.kind, file: r.fromFile, line: r.line });
    if (out.length >= limit) break;
  }
  return out;
}

async function impactNoFresh(backend: StorageBackend, rootAbs: string, name: string, depth: number): Promise<{ files: string[]; symbols: SymbolHit[] }> {
  const store = backend.codeGraph();
  const seeds = await store.symbolsByName(rootAbs, name, 20);
  if (seeds.length === 0) return { files: [], symbols: [] };
  let frontierFiles = [...new Set(seeds.map((s) => s.file))];
  const visitedFiles = new Set(frontierFiles);
  const dependentSymbols = new Map<number, SymbolRow>();
  for (let hop = 0; hop < depth; hop++) {
    const edges = await store.refsToFiles(rootAbs, frontierFiles);
    const nextFiles: string[] = [];
    for (const e of edges) if (!visitedFiles.has(e.fromFile)) { visitedFiles.add(e.fromFile); nextFiles.push(e.fromFile); }
    for (const f of nextFiles) for (const s of await store.symbolsInFile(rootAbs, f)) dependentSymbols.set(s.id, s);
    if (nextFiles.length === 0) break;
    frontierFiles = nextFiles;
  }
  return { files: [...visitedFiles].sort(), symbols: [...dependentSymbols.values()].map(toHit) };
}

/** file existence guard used by sourceOf's sibling callers in tests */
export function fileExists(rootAbs: string, rel: string): boolean {
  return existsSync(`${rootAbs}/${rel}`);
}
