/**
 * Public code-graph API — the stable surface CLI/MCP tools build on.
 *
 * Every query function runs ensureFresh() first so answers never come from a
 * stale index: lazy full index on first sight of a repo, then a cheap
 * mtime→hash reconcile per call (ponytail: a watcher daemon would replace it).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { StorageBackend } from "../storage/interface.js";
import type { CodeGraphStore, SymbolRow } from "./store.js";
import { findSummary } from "./summaries.js";
import { indexFiles, indexRoot, reconcile } from "./indexer.js";
import { consumeDirty, readDirty, runningIndex } from "./session.js";
import { extractFile } from "./extract/index.js";
import { exactNameTokens, pathWords, questionTerms, rankCandidates } from "./rank.js";
import type { RelateProject } from "./relate.js";
import { relatedElsewhere } from "./graph.js";
import { sanitize } from "./sanitize.js";

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

/**
 * The main checkout of the repo `cwd` is in — a linked worktree's is its parent
 * repo. The code graph keys every row by repo root, and only the main checkout
 * is a registered project: querying from a worker worktree must use the main
 * checkout's index (a worktree was re-indexed from scratch there, > 120 s per
 * explore call), never a second copy. `--path-format=absolute` needs git ≥ 2.31;
 * on older git we resolve the relative answer against cwd ourselves. Not a git
 * repo: cwd itself.
 */
export function mainCheckoutOf(cwd?: string): string {
  const start = resolve(cwd ?? process.cwd());
  let common = "";
  try {
    common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: start, encoding: "utf8" }).trim();
  } catch {
    try {
      common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: start, encoding: "utf8" }).trim();
    } catch {
      return start; // not a git repo
    }
  }
  if (!common) return start;
  const abs = isAbsolute(common) ? common : resolve(start, common);
  return basename(abs) === ".git" ? dirname(abs) : abs;
}

/** Index root for queries: the main checkout when `root` is a linked worktree of it. */
export function graphRoot(root?: string): string {
  const r = resolve(root ?? process.cwd());
  // a *linked* worktree moves to its parent repo (git identity: --git-common-dir,
  // which never resolves path symlinks); a plain repo stays at its own path —
  // git's --show-toplevel would resolve symlinks and move a /tmp repo off its rows
  let common = "";
  try {
    common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: r, encoding: "utf8" }).trim();
  } catch { /* not a git repo */ }
  if (!common) return r;
  const abs = isAbsolute(common) ? common : resolve(r, common);
  const main = basename(abs) === ".git" ? dirname(abs) : abs;
  return main !== r && existsSync(main) ? main : r;
}


/**
 * Where a symbol's source is read from: the worktree when the query started in
 * one (the worker's own edits are fresher there), else the index root.
 */
function readRoot(indexRootAbs: string, cwd?: string): string {
  if (!cwd) return indexRootAbs;
  const start = resolve(cwd);
  // only a linked worktree reads from its own tree (identity via git, not path text)
  return mainCheckoutOf(start) === indexRootAbs && start !== indexRootAbs ? start : indexRootAbs;
}

/** The commit a worker worktree started from: the first entry of its branch reflog. */
function firstCommitOfBranch(dir: string): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    if (!head || head === "HEAD") return null; // detached: no branch reflog
    // --date=unix keeps the output one line per entry (%(timestamp) would pad it)
    const out = execFileSync("git", ["reflog", "show", "--format=%H", "--date=unix", `refs/heads/${head}`], { cwd: dir, encoding: "utf8" });
    const lines = out.trim().split("\n").filter(Boolean);
    return lines[lines.length - 1] || null; // oldest entry: the worktree's start point
  } catch {
    return null;
  }
}

/** Full (incremental) index of a repo. A linked worktree indexes into its main checkout's rows. */
export async function indexRepo(backend: StorageBackend, root: string, opts?: { force?: boolean }): Promise<IndexStats> {
  const t0 = Date.now();
  const store = backend.codeGraph();
  // key rows by the plain resolved path (indexRoot does the same) — callers pass a
  // toplevel; realpath would move a /tmp repo. A linked worktree moves to its parent.
  const rootAbs = graphRoot(resolve(root));
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

/**
 * Lazy full index when the repo was never indexed; else a cheap reconcile. Null
 * when nothing changed. `root` may be a linked worktree: the rows live under
 * the main checkout, and the worktree's own changed files are re-read from the
 * worktree for freshness (never a second index).
 */
export async function ensureFresh(backend: StorageBackend, root?: string): Promise<IndexStats | null> {
  const store = backend.codeGraph();
  // the caller's own tree path (worktree identity kept: readDirty/indexFiles use it);
  // rows live under the toplevel as git sees it, or its parent repo for a linked worktree
  // the caller's path keeps its identity (worktrees included); rows are keyed by
  // the plain resolved path, or by the parent repo for a linked worktree
  const start = resolve(root ?? process.cwd());
  const rootAbs = graphRoot(start);
  // a linked worktree of this repo (git identity, not path text): its own tree is fresh
  const worktree = start !== rootAbs && mainCheckoutOf(start) === rootAbs ? start : undefined;
  const t0 = Date.now();
  const existing = await store.stats(rootAbs);
  if (existing.files === 0) {
    return indexRepo(backend, rootAbs);
  }
  // files the Edit/Write hook marked dirty are re-read first (no parse happened in the hook)
  const worktreeRoot = worktree ?? rootAbs;
  const dirty = [...consumeDirty(rootAbs), ...(worktree ? consumeDirty(worktree) : [])];
  let changed = dirty.length ? (await indexFiles(store, worktreeRoot, dirty)).changed : 0;
  // a worktree's own files are brought in from the worktree — vs the branch it
  // started from (cheap: git status + those files), never a second full index.
  if (worktree) {
    const edited = new Set<string>();
    try {
      for (const l of execFileSync("git", ["status", "--porcelain", "-z"], { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0")) {
        if (!l.trim()) continue;
        const p = l.slice(3).split(" -> ").pop()!; // renames: the new path
        if (p) edited.add(p);
      }
    } catch { /* no git status: rely on the reconcile below */ }
    changed += (await indexFiles(store, worktree, [...edited])).changed;
    const base = firstCommitOfBranch(worktree);
    if (base) {
      const committed = new Set<string>();
      try {
        for (const p of execFileSync("git", ["diff", "--name-only", "-z", `${base}..HEAD`], { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0")) {
          if (p) committed.add(p);
        }
      } catch { /* base unreachable: skip */ }
      changed += (await indexFiles(store, worktree, [...committed])).changed;
    }
    if (!dirty.length && !edited.size && !base) {
      // nothing the worker touched is visible to git here: fall back to the plain reconcile
      const r = await reconcile(store, rootAbs);
      if (r) return finishStats(backend, store, rootAbs, r, t0);
    }
    return null;
  }
  const rec = await reconcile(store, rootAbs);
  const counts = rec ? { changed: rec.changed + changed, deleted: rec.deleted } : changed ? { changed, deleted: 0 } : null;
  if (!counts) return null;
  return finishStats(backend, store, rootAbs, counts, t0);
}

async function finishStats(backend: StorageBackend, store: CodeGraphStore, rootAbs: string, counts: { changed: number; deleted: number }, t0: number): Promise<IndexStats> {
  const s = await store.stats(rootAbs);
  return {
    root: rootAbs,
    backend: backend.backendType,
    files: s.files,
    symbols: s.symbols,
    refs: s.refs,
    resolvedRefs: s.resolvedRefs,
    changed: counts.changed,
    deleted: counts.deleted,
    ms: Date.now() - t0,
  };
}


export async function status(backend: StorageBackend, root: string): Promise<{
  root: string; backend: string; indexed: boolean; files: number; symbols: number;
  refs: number; resolvedRefs: number; byLanguage: Record<string, number>; lastIndexedAt: string | null;
  dirty: number; indexing: { pid: number; root: string; startedAt: string } | null;
}> {
  const store = backend.codeGraph();
  const rootAbs = graphRoot(root);
  const start = resolve(root);
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
    dirty: readDirty(rootAbs).length + (start === rootAbs ? 0 : readDirty(start).length),
    indexing: ((l) => (l ? { pid: l.pid, root: l.root, startedAt: new Date(l.startedAt).toISOString() } : null))(runningIndex()),
  };
}

export async function searchSymbols(backend: StorageBackend, root: string, query: string, limit?: number): Promise<SymbolHit[]> {
  await ensureFresh(backend, root);
  const rows = await backend.codeGraph().searchSymbols(graphRoot(root), query, limit ?? 20);
  return rows.map(toHit);
}

export async function callers(backend: StorageBackend, root: string, name: string, limit?: number): Promise<RefHit[]> {
  await ensureFresh(backend, root);
  const store = backend.codeGraph();
  const rootAbs = graphRoot(root);
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
  const rootAbs = graphRoot(root);
  const targets = await store.symbolsByName(rootAbs, name, 20);
  const seen = new Set<string>();
  const out: RefHit[] = [];
  for (const t of targets) {
    // refs to the definition's own parameters/locals are not callees. The
    // extractor skips them since 1.2.81, but stored rows can predate it
    // (unchanged files are never re-read), so filter here too: drop any ref
    // whose name is bound inside this symbol's source range and that did not
    // resolve to a repo symbol (a same-named real symbol stays listed).
    const locals = await localNamesOf(rootAbs, t);
    for (const r of await store.callees(t.id)) {
      if (!r.target && locals.has(r.toName)) continue;
      const key = `${r.fromFile}:${r.line}:${r.toName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ symbol: r.target ? toHit(r.target) : null, name: r.toName, kind: r.kind, file: r.fromFile, line: r.line });
      if (out.length >= (limit ?? 50)) return out;
    }
  }
  return out;
}

/** Names bound as parameters or locals inside the symbol's own source range.
 *  Re-parses the defining file from disk (one parse per callee lookup). The
 *  extractor records local bindings before refs and suppresses a ref whose
 *  target is bound in the enclosing definition — so the identifiers that
 *  occur in this slice but produce no ref here are exactly its locals. */
async function localNamesOf(rootAbs: string, s: SymbolRow): Promise<Set<string>> {
  const out = new Set<string>();
  let content: string;
  try {
    const lines = readFileSync(join(rootAbs, s.file), "utf8").split("\n");
    if (lines.length < s.startLine) return out;
    content = lines.slice(s.startLine - 1, Math.max(s.endLine, s.startLine)).join("\n");
  } catch {
    return out; // definition no longer on disk at its stored range: no filter
  }
  const extracted = await extractFile({ path: s.file, content, mtime: 0 });
  if (!extracted) return out;
  const refed = new Set(extracted.refs.map((r) => r.toName));
  for (const m of content.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    if (!refed.has(m[0])) out.add(m[0]);
  }
  return out;
}

/** Transitive dependents of the symbol `name` up to `depth` hops. */
export async function impact(backend: StorageBackend, root: string, name: string, depth = 2): Promise<{ files: string[]; symbols: SymbolHit[] }> {
  await ensureFresh(backend, root);
  const store = backend.codeGraph();
  const rootAbs = graphRoot(root);

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

/** verbatim source of a symbol, read from disk by line range */
function sourceOf(rootAbs: string, s: SymbolHit): string {
  try {
    const lines = readFileSync(join(rootAbs, s.file), "utf8").split("\n");
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
  rawQuery: string,
  opts?: { budgetTokens?: number; depth?: number; projects?: RelateProject[] },
): Promise<ExploreResult> {
  await ensureFresh(backend, root);
  const store = backend.codeGraph();
  const rootAbs = graphRoot(root);
  // when the query runs from a linked worktree of this repo, read source there:
  // the worker's own edits are fresher than the main checkout
  const srcRoot = readRoot(rootAbs, root);
  const budgetChars = (opts?.budgetTokens ?? 4000) * 4;
  const depth = opts?.depth ?? 1;

  // question terms (stopwords dropped), candidates from name, FTS and path, then ranked
  const query = sanitize(rawQuery);
  const terms = questionTerms(query);
  const exactTokens = exactNameTokens(query);
  const exactNames = new Set(exactTokens);
  const candidates: SymbolRow[] = [];
  for (const t of exactTokens) candidates.push(...await store.symbolsByName(rootAbs, t, 5));
  for (const t of terms) {
    candidates.push(...await store.symbolsByName(rootAbs, t, 5));
    candidates.push(...await store.searchSymbols(rootAbs, t, 60));
  }
  if (terms.length) {
    const pathHits = (await store.listFiles(rootAbs))
      .map((f) => ({ path: f.path, n: terms.filter((t) => pathWords(f.path).has(t)).length }))
      .filter((f) => f.n > 0)
      .sort((a, b) => b.n - a.n || a.path.length - b.path.length)
      .slice(0, 8);
    for (const f of pathHits) candidates.push(...await store.symbolsInFile(rootAbs, f.path));
  }
  const ranked = rankCandidates(candidates, terms, exactNames, { files: 6, perFile: 4, total: 12 });
  const symbols = ranked.flatMap((f) => f.symbols.map((r) => toHit(r.symbol)));

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

  // module and repo summaries (when generated) for the modules the symbols live in
  const sumPaths = [...new Set([...symbols.map((s) => s.file.includes("/") ? s.file.slice(0, s.file.lastIndexOf("/")) : "."), "."])];
  const seenSum = new Set<string>();
  for (const p of sumPaths) {
    const sm = await findSummary(store, rootAbs, p);
    if (!sm || seenSum.has(sm.key)) continue;
    seenSum.add(sm.key);
    push(`\n## ${sm.kind === "repo" ? "Repo" : "Module"} summary: ${sm.path}\n${sm.summary.slice(0, 700)}\n`);
  }

  // definitions grouped by file
  const byFile = new Map<string, SymbolHit[]>();
  for (const f of ranked) byFile.set(f.file, f.symbols.map((r) => toHit(r.symbol)));
  for (const [file, syms] of byFile) {
    if (!push(`\n## ${file}\n`)) break;
    for (const s of syms) {
      const body = sourceOf(srcRoot, s);
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

  // other projects and notes that depend on / call / duplicate / mention the seed symbols
  if (!truncated && opts?.projects?.length && symbols.length) {
    try {
      const rel = await relatedElsewhere(backend, opts.projects, rootAbs, symbols);
      if (rel) push(rel);
    } catch { /* relations are optional context */ }
  }

  return { text, symbols, truncated };
}

// internal variants that skip the ensureFresh round-trip (explore already refreshed)
async function callersNoFresh(backend: StorageBackend, rootAbs: string, name: string, limit: number): Promise<RefHit[]> {
  return callersFromStore(backend.codeGraph(), rootAbs, name, limit);
}
async function calleesNoFresh(backend: StorageBackend, rootAbs: string, qualifiedName: string, limit: number): Promise<RefHit[]> {
  const store = backend.codeGraph();
  // same own-parameters/locals filter as callees() (stored rows may predate
  // the extractor fix); a ref's enclosing symbol is matched by name+file
  const seeds = await store.symbolsByName(rootAbs, qualifiedName, 20);
  const localsOf = new Map<string, Set<string>>(); // `${file}#${qualifiedName}` → local names
  const out: RefHit[] = [];
  for (const r of await store.calleesByName(rootAbs, qualifiedName, limit)) {
    if (!r.target && r.fromSymbol) {
      const key = `${r.fromFile}#${r.fromSymbol}`;
      let ls = localsOf.get(key);
      if (!ls) {
        const seed = seeds.find((s) => s.file === r.fromFile && s.qualifiedName === r.fromSymbol);
        ls = seed ? await localNamesOf(rootAbs, seed) : new Set<string>();
        localsOf.set(key, ls);
      }
      if (ls.has(r.toName)) continue;
    }
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
