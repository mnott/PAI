/**
 * CodeGraphStore — the storage contract of the code knowledge graph.
 *
 * One instance per StorageBackend (backend.codeGraph()), so callers never
 * know whether rows live in SQLite or Postgres. Everything is scoped by
 * repo_root: many repos share the same tables.
 */

export type SymbolKind =
  | "function" | "method" | "class" | "struct" | "protocol"
  | "interface" | "enum" | "type" | "variable" | "route";

export type RefKind = "call" | "import" | "extends" | "implements" | "references";

/** A file row plus its freshly extracted symbols and refs, written atomically. */
export interface FileRecord {
  /** repo-relative path (posix separators) */
  path: string;
  language: string;
  contentHash: string;
  mtime: number;
  size: number;
  symbols: SymbolRecord[];
  refs: RefRecord[];
}

export interface SymbolRecord {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string;
  /** doc comment (/// or /** …) attached to the definition, when any */
  doc?: string;
  exported: boolean;
}

export interface RefRecord {
  /** symbol id within the same FileRecord, when the ref sits inside one */
  fromSymbolIndex?: number;
  toName: string;
  kind: RefKind;
  line: number;
}

export interface CodeFileRow {
  id: number;
  path: string;
  language: string;
  contentHash: string;
  mtime: number;
  size: number;
  indexedAt: number;
}

export interface SymbolRow {
  id: number;
  name: string;
  qualifiedName: string;
  kind: string;
  /** repo-relative path of the defining file */
  file: string;
  fileId: number;
  startLine: number;
  endLine: number;
  signature: string;
  /** doc comment attached to the definition ("" when none is stored) */
  doc: string;
  exported: boolean;
}

export interface RefRow {
  id: number;
  kind: string;
  line: number;
  toName: string;
  toSymbolId: number | null;
  fromFile: string;
  /** name of the symbol the ref sits in, null for file-level refs */
  fromSymbol: string | null;
}

export interface CodeGraphStats {
  files: number;
  symbols: number;
  refs: number;
  resolvedRefs: number;
  byLanguage: Record<string, number>;
  lastIndexedAt: number | null;
}

/** Where a ref points after resolution: the matched symbol row, or null. */
export interface ResolvedRefRow extends RefRow {
  /** the resolved target symbol (to_symbol_id), when linked */
  target: SymbolRow | null;
}

/** A relation between two typed keys (see relate.ts for the key grammar and predicates). */
export interface TripleSpec {
  subject: string;
  predicate: string;
  object: string;
  confidence: "EXTRACTED" | "INFERRED";
  projectId?: number | null;
}

export interface TripleRow extends TripleSpec {
  id: number;
  /** epoch ms */
  validFrom: number;
  /** epoch ms; null while the relation holds */
  validTo: number | null;
}

export interface CodeGraphStore {
  /** Insert or replace a file with its symbols+refs in one transaction.
   *  Returns the file row id. Symbols/refs of the previous version are removed
   *  (cascade); refs from OTHER files that pointed at its symbols are nulled
   *  and returned here so the resolver can re-link them. */
  upsertFile(repoRoot: string, file: FileRecord): Promise<{ fileId: number; brokenRefIds: number[] }>;

  /** Delete files (symbols/refs cascade; inbound to_symbol_id links null).
   *  Takes the paths in batches so a whole-repo wipe is a handful of set-based
   *  statements, not one delete per file. Returns the ids of refs that pointed
   *  at deleted symbols and must be re-resolved. */
  deleteFiles(repoRoot: string, paths: string[]): Promise<{ brokenRefIds: number[] }>;

  /** Wipe every row of a repo (files + their symbols/refs) in one set-based
   *  transaction — the --force path. No brokenRefIds: every ref of the repo is
   *  gone with it, and the reindex rebuilds them. */
  clearRepo(repoRoot: string): Promise<void>;

  /** Refresh mtime/size/indexed_at after a touch whose content hash did not change —
   *  never touches symbols/refs (unlike upsertFile, which replaces them). */
  touchFileMtime(repoRoot: string, path: string, mtime: number, size: number): Promise<void>;

  /** All indexed files for a repo: path/hash/mtime (+id, language). */
  listFiles(repoRoot: string): Promise<CodeFileRow[]>;

  /** Every ref whose source file is one of `paths`, with resolved targets. */
  resolveRefs(repoRoot: string, paths: string[]): Promise<ResolvedRefRow[]>;

  /** Refs still without a resolved target, limited to the given files (all when empty). */
  unresolvedRefsInFiles(repoRoot: string, paths: string[]): Promise<ResolvedRefRow[]>;

  /** Full-text symbol search (sub-word identifier matching built in). */
  searchSymbols(repoRoot: string, query: string, limit?: number): Promise<SymbolRow[]>;

  /** Exact-name symbol matches. */
  symbolsByName(repoRoot: string, name: string, limit?: number): Promise<SymbolRow[]>;

  symbolsInFile(repoRoot: string, path: string): Promise<SymbolRow[]>;

  /** Refs pointing AT a symbol (by id or by name) — who uses it. */
  callers(symbolId: number): Promise<RefRow[]>;
  callersByName(repoRoot: string, name: string, limit?: number): Promise<ResolvedRefRow[]>;

  /** Refs made FROM a symbol (by id or by qualified name) — what it uses. */
  callees(symbolId: number): Promise<ResolvedRefRow[]>;
  calleesByName(repoRoot: string, name: string, limit?: number): Promise<ResolvedRefRow[]>;

  /** Files that depend on the files defining `name` (direct referrers). */
  refsToFiles(repoRoot: string, paths: string[]): Promise<Array<{ fromFile: string; toFile: string }>>;

  /** Set or clear (null) the resolved target of a ref. */
  setRefTarget(refId: number, symbolId: number | null): Promise<void>;

  /** Batched setRefTarget: one statement per chunk, not one per ref. */
  setRefTargets(pairs: Array<{ refId: number; symbolId: number }>): Promise<void>;

  /** Ids of refs with no resolved target (bare to_name kept). */
  unresolvedRefIds(repoRoot: string): Promise<number[]>;

  /** All symbols of a repo, with their file paths. */
  allSymbols(repoRoot: string): Promise<SymbolRow[]>;

  stats(repoRoot: string): Promise<CodeGraphStats>;

  /** Make the open triples owned by `scope` equal `desired`: new ones are inserted, ones that
   *  vanished get valid_to set (never deleted). Rows live in kg_triples (source_session = scope). */
  syncTriples(scope: string, desired: TripleSpec[]): Promise<{ added: number; closed: number; kept: number }>;

  /** Open triples (or all, with includeClosed) whose subject or object is one of `keys`. */
  triplesTouching(keys: string[], opts?: { limit?: number; includeClosed?: boolean }): Promise<TripleRow[]>;

  /** Triple counts per predicate for relations written by relate (source_session 'relate:*'). */
  tripleCounts(): Promise<Record<string, { open: number; closed: number }>>;
}
