/**
 * SQLite implementation of CodeGraphStore over the federation database.
 *
 * Full-text search runs through the external-content FTS5 table
 * code_symbols_fts (see schema-sqlite.ts); its triggers keep it in sync with
 * code_symbols.search_text, which already carries the sub-word expanded
 * identifier text (fts.ts) so camelCase/snake_case queries match.
 */

import type { Database } from "better-sqlite3";
import { CODEGRAPH_SQLITE_SQL, CODE_SUMMARIES_SQLITE_SQL } from "./schema-sqlite.js";
import { symbolFtsText } from "./fts.js";
import type {
  CodeGraphStore, CodeFileRow, CodeGraphStats, FileRecord, RefRow,
  ResolvedRefRow, SymbolRow, TripleSpec, TripleRow, SummaryRow,
} from "./store.js";

/** Paths per delete statement in deleteFiles (same bound as the Postgres store). */
const DELETE_BATCH = 500;

interface SymDbRow {
  id: number; repo_root: string; file_id: number; name: string;
  qualified_name: string; kind: string; start_line: number; end_line: number;
  signature: string; exported: number; doc?: string;
}
interface FileDbRow {
  id: number; path: string; language: string; content_hash: string;
  mtime: number; size: number; indexed_at: number;
}
interface RefDbRow {
  id: number; kind: string; line: number; to_name: string; to_symbol_id: number | null;
  from_file: string; from_symbol: string | null;
  t_name?: string; t_qualified_name?: string; t_kind?: string;
  t_file?: string; t_file_id?: number; t_start_line?: number; t_end_line?: number;
  t_signature?: string; t_exported?: number;
}

interface SumDbRow {
  key: string; kind: string; path: string; summary: string; model: string;
  source_hash: string; generated_at: number;
}
function mapSummary(r: SumDbRow): SummaryRow {
  return { key: r.key, kind: r.kind as SummaryRow["kind"], path: r.path, summary: r.summary, model: r.model, sourceHash: r.source_hash, generatedAt: Number(r.generated_at) };
}

function mapSymbol(r: SymDbRow): SymbolRow {
  return {
    id: r.id, name: r.name, qualifiedName: r.qualified_name, kind: r.kind,
    file: (r as unknown as { file: string }).file, fileId: r.file_id,
    startLine: r.start_line, endLine: r.end_line, signature: r.signature,
    doc: r.doc ?? "", exported: r.exported === 1,
  };
}

function mapRef(r: RefDbRow): ResolvedRefRow {
  const target: SymbolRow | null = r.to_symbol_id == null ? null : {
    id: r.to_symbol_id, name: r.t_name!, qualifiedName: r.t_qualified_name!, kind: r.t_kind!,
    file: r.t_file!, fileId: r.t_file_id!, startLine: r.t_start_line!, endLine: r.t_end_line!,
    signature: r.t_signature!, doc: "", exported: r.t_exported === 1,
  };
  return {
    id: r.id, kind: r.kind, line: r.line, toName: r.to_name, toSymbolId: r.to_symbol_id,
    fromFile: r.from_file, fromSymbol: r.from_symbol, target,
  };
}

const REF_SELECT = `
  SELECT cr.id, cr.kind, cr.line, cr.to_name, cr.to_symbol_id,
         cf.path AS from_file, fs.qualified_name AS from_symbol,
         ts.name AS t_name, ts.qualified_name AS t_qualified_name, ts.kind AS t_kind,
         tf.path AS t_file, tf.id AS t_file_id, ts.start_line AS t_start_line,
         ts.end_line AS t_end_line, ts.signature AS t_signature, ts.exported AS t_exported
  FROM code_refs cr
  JOIN code_files cf ON cf.id = cr.from_file_id
  LEFT JOIN code_symbols fs ON fs.id = cr.from_symbol_id
  LEFT JOIN code_symbols ts ON ts.id = cr.to_symbol_id
  LEFT JOIN code_files tf ON tf.id = ts.file_id`;

export class SqliteCodeGraphStore implements CodeGraphStore {
  private db: Database;
  /** one-time-per-instance schema guard (the store may be created on a DB opened before this feature existed) */
  private ready = false;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * The federation schema (initializeFederationSchema, run on every open) does
   * not create the code-graph tables — they are an incremental migration here,
   * applied once per store instance. The FTS triggers carry no IF NOT EXISTS
   * (it cannot run inside a multi-statement db.exec() through better-sqlite3's
   * splitter), so they get explicit sqlite_master guards below.
   */
  private ensure(): void {
    if (this.ready) return;
    // Everything up to the first trigger (tables, FTS5 table, indexes — all IF NOT EXISTS).
    // A comment mentioning CREATE TRIGGER sits between the tables and the index block; the old
    // cut at that word silently dropped every index (a ref lookup took 88 ms instead of <1 ms).
    const cut = CODEGRAPH_SQLITE_SQL.indexOf("-- The FTS sync triggers");
    // the unique open-triple index sits between the kg_triples table and the first CREATE INDEX;
    // slicing only from "CREATE INDEX" would drop it (same trap as the trigger comment above)
    const indexes = CODEGRAPH_SQLITE_SQL.slice(CODEGRAPH_SQLITE_SQL.indexOf("CREATE UNIQUE INDEX"));
    // the doc-column migration below the index block is guarded here: SQLite has
    // no ADD COLUMN IF NOT EXISTS, and a plain ALTER would throw on every re-run
    this.db.exec(CODEGRAPH_SQLITE_SQL.slice(0, cut) + indexes);
    // the open-unique index is a partial index; verify it really exists (older DBs predate it)
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_kg_open_triple'").get()) {
      this.db.exec("CREATE UNIQUE INDEX uq_kg_open_triple ON kg_triples(subject, predicate, object) WHERE valid_to IS NULL");
    }
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('code_symbols') WHERE name='doc'").get()) {
      this.db.exec("ALTER TABLE code_symbols ADD COLUMN doc TEXT NOT NULL DEFAULT ''");
    }
    for (const [name, sql] of [
      ["code_symbols_ai", `CREATE TRIGGER code_symbols_ai AFTER INSERT ON code_symbols BEGIN
        INSERT INTO code_symbols_fts (rowid, search_text) VALUES (new.id, new.search_text); END`],
      ["code_symbols_ad", `CREATE TRIGGER code_symbols_ad AFTER DELETE ON code_symbols BEGIN
        INSERT INTO code_symbols_fts (code_symbols_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text); END`],
      ["code_symbols_au", `CREATE TRIGGER code_symbols_au AFTER UPDATE ON code_symbols BEGIN
        INSERT INTO code_symbols_fts (code_symbols_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
        INSERT INTO code_symbols_fts (rowid, search_text) VALUES (new.id, new.search_text); END`],
    ] as const) {
      const has = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
      if (!has) this.db.exec(sql);
    }
    this.db.exec(CODE_SUMMARIES_SQLITE_SQL);
    this.ready = true;
  }

  async upsertFile(repoRoot: string, file: FileRecord): Promise<{ fileId: number; brokenRefIds: number[] }> {
    this.ensure();
    const db = this.db;
    return db.transaction(() => {
      const existing = db
        .prepare("SELECT id FROM code_files WHERE repo_root = ? AND path = ?")
        .get(repoRoot, file.path) as { id: number } | undefined;

      let brokenRefIds: number[] = [];
      if (existing) {
        // refs pointing at this file's old symbols must be re-resolved after the replace
        brokenRefIds = (db
          .prepare(
            `SELECT cr.id FROM code_refs cr
             JOIN code_symbols s ON s.id = cr.to_symbol_id
             WHERE s.file_id = ?`
          )
          .all(existing.id) as Array<{ id: number }>).map((r) => r.id);
        // deleting the file row cascades to its symbols and outgoing refs;
        // inbound refs keep their rows with to_symbol_id NULL'd (FK SET NULL)
        db.prepare("DELETE FROM code_files WHERE id = ?").run(existing.id);
      }

      const info = db
        .prepare(
          `INSERT INTO code_files (repo_root, path, language, content_hash, mtime, size, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(repoRoot, file.path, file.language, file.contentHash, file.mtime, file.size, Date.now());
      const fileId = Number(info.lastInsertRowid);

      const insertSym = db.prepare(
        `INSERT INTO code_symbols (repo_root, file_id, name, qualified_name, kind, start_line, end_line, signature, exported, search_text, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const symbolIds: number[] = [];
      for (const s of file.symbols) {
        const r = insertSym.run(
          repoRoot, fileId, s.name, s.qualifiedName, s.kind, s.startLine, s.endLine,
          s.signature, s.exported ? 1 : 0, symbolFtsText(s.name, s.qualifiedName, s.signature),
          s.doc ?? "",
        );
        symbolIds.push(Number(r.lastInsertRowid));
      }

      const insertRef = db.prepare(
        `INSERT INTO code_refs (repo_root, from_file_id, from_symbol_id, to_name, kind, line)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const ref of file.refs) {
        const fromSymbolId =
          ref.fromSymbolIndex != null ? symbolIds[ref.fromSymbolIndex] ?? null : null;
        insertRef.run(repoRoot, fileId, fromSymbolId, ref.toName, ref.kind, ref.line);
      }
      return { fileId, brokenRefIds };
    })();
  }

  /** Batched like the Postgres store's: one statement per DELETE_BATCH paths. */
  async deleteFiles(repoRoot: string, paths: string[]): Promise<{ brokenRefIds: number[] }> {
    this.ensure();
    if (paths.length === 0) return { brokenRefIds: [] };
    const db = this.db;
    return db.transaction(() => {
      const broken: number[] = [];
      for (let i = 0; i < paths.length; i += DELETE_BATCH) {
        const batch = paths.slice(i, i + DELETE_BATCH);
        const placeholders = batch.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT cr.id FROM code_refs cr
             JOIN code_symbols s ON s.id = cr.to_symbol_id
             WHERE s.file_id IN (SELECT id FROM code_files WHERE repo_root = ? AND path IN (${placeholders}))`
          )
          .all(repoRoot, ...batch) as Array<{ id: number }>;
        for (const r of rows) broken.push(r.id);
        db.prepare(`DELETE FROM code_files WHERE repo_root = ? AND path IN (${placeholders})`).run(repoRoot, ...batch);
      }
      return { brokenRefIds: broken };
    })();
  }

  /** Three set-based deletes in one transaction; the cascade + FTS triggers do
   *  the rest (foreign_keys is on for the federation db — see federation-db). */
  async clearRepo(repoRoot: string): Promise<void> {
    this.ensure();
    const db = this.db;
    db.transaction(() => {
      db.prepare("DELETE FROM code_refs WHERE repo_root = ?").run(repoRoot);
      db.prepare("DELETE FROM code_symbols WHERE repo_root = ?").run(repoRoot);
      db.prepare("DELETE FROM code_files WHERE repo_root = ?").run(repoRoot);
    })();
  }

  async touchFileMtime(repoRoot: string, path: string, mtime: number, size: number): Promise<void> {
    this.ensure();
    this.db
      .prepare("UPDATE code_files SET mtime = ?, size = ?, indexed_at = ? WHERE repo_root = ? AND path = ?")
      .run(mtime, size, Date.now(), repoRoot, path);
  }

  async listFiles(repoRoot: string): Promise<CodeFileRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        "SELECT id, path, language, content_hash, mtime, size, indexed_at FROM code_files WHERE repo_root = ? ORDER BY path"
      )
      .all(repoRoot) as FileDbRow[];
    return rows.map((r) => ({
      id: r.id, path: r.path, language: r.language, contentHash: r.content_hash,
      mtime: r.mtime, size: r.size, indexedAt: r.indexed_at,
    }));
  }

  async resolveRefs(repoRoot: string, paths: string[]): Promise<ResolvedRefRow[]> {
    this.ensure();
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(",");
    const rows = this.db
      .prepare(`${REF_SELECT} WHERE cf.repo_root = ? AND cf.path IN (${placeholders}) ORDER BY cr.id`)
      .all(repoRoot, ...paths) as RefDbRow[];
    return rows.map(mapRef);
  }

  async unresolvedRefsInFiles(repoRoot: string, paths: string[]): Promise<ResolvedRefRow[]> {
    this.ensure();
    const params: (string | number)[] = [repoRoot];
    let sql = `${REF_SELECT} WHERE cr.repo_root = ? AND cr.to_symbol_id IS NULL`;
    if (paths.length > 0) {
      sql += ` AND cf.path IN (${paths.map(() => "?").join(",")})`;
      params.push(...paths);
    }
    return (this.db.prepare(`${sql} ORDER BY cr.id`).all(...params) as RefDbRow[]).map(mapRef);
  }

  async searchSymbols(repoRoot: string, query: string, limit = 20): Promise<SymbolRow[]> {
    this.ensure();
    // same tokenising as memory/search.ts buildFtsQuery: quoted OR terms; the
    // stored search_text already contains sub-word forms of every identifier.
    const ftsQuery = query
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length >= 2)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT s.*, cf.path AS file, bm25(code_symbols_fts) AS rank
         FROM code_symbols_fts
         JOIN code_symbols s ON s.id = code_symbols_fts.rowid
         JOIN code_files cf ON cf.id = s.file_id
         WHERE code_symbols_fts MATCH ? AND s.repo_root = ?
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, repoRoot, limit) as Array<SymDbRow & { file: string }>;
    return rows.map(mapSymbol);
  }

  async symbolsByName(repoRoot: string, name: string, limit = 50): Promise<SymbolRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        `SELECT s.*, cf.path AS file FROM code_symbols s
         JOIN code_files cf ON cf.id = s.file_id
         WHERE s.repo_root = ? AND (s.name = ? OR s.qualified_name = ?)
         ORDER BY s.exported DESC, s.start_line LIMIT ?`
      )
      .all(repoRoot, name, name, limit) as Array<SymDbRow & { file: string }>;
    return rows.map(mapSymbol);
  }

  async symbolsInFile(repoRoot: string, path: string): Promise<SymbolRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        `SELECT s.*, cf.path AS file FROM code_symbols s
         JOIN code_files cf ON cf.id = s.file_id
         WHERE s.repo_root = ? AND cf.path = ? ORDER BY s.start_line`
      )
      .all(repoRoot, path) as Array<SymDbRow & { file: string }>;
    return rows.map(mapSymbol);
  }

  async callers(symbolId: number): Promise<RefRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(`${REF_SELECT} WHERE cr.to_symbol_id = ? ORDER BY cf.path, cr.line`)
      .all(symbolId) as RefDbRow[];
    return rows.map(mapRef);
  }

  async callersByName(repoRoot: string, name: string, limit = 50): Promise<ResolvedRefRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(`${REF_SELECT} WHERE cr.repo_root = ? AND cr.to_name = ? ORDER BY cf.path, cr.line LIMIT ?`)
      .all(repoRoot, name, limit) as RefDbRow[];
    return rows.map(mapRef);
  }

  async callees(symbolId: number): Promise<ResolvedRefRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(`${REF_SELECT} WHERE cr.from_symbol_id = ? ORDER BY cr.line`)
      .all(symbolId) as RefDbRow[];
    return rows.map(mapRef);
  }

  async calleesByName(repoRoot: string, name: string, limit = 50): Promise<ResolvedRefRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(`${REF_SELECT} WHERE cr.repo_root = ? AND fs.qualified_name = ? ORDER BY cr.line LIMIT ?`)
      .all(repoRoot, name, limit) as RefDbRow[];
    return rows.map(mapRef);
  }

  async refsToFiles(repoRoot: string, paths: string[]): Promise<Array<{ fromFile: string; toFile: string }>> {
    this.ensure();
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT DISTINCT cf.path AS "fromFile", tf.path AS "toFile"
         FROM code_refs cr
         JOIN code_symbols ts ON ts.id = cr.to_symbol_id
         JOIN code_files tf ON tf.id = ts.file_id
         JOIN code_files cf ON cf.id = cr.from_file_id
         WHERE cr.repo_root = ? AND tf.path IN (${placeholders}) AND cf.path != tf.path`
      )
      .all(repoRoot, ...paths) as Array<{ fromFile: string; toFile: string }>;
  }

  async setRefTarget(refId: number, symbolId: number | null): Promise<void> {
    this.ensure();
    this.db.prepare("UPDATE code_refs SET to_symbol_id = ? WHERE id = ?").run(symbolId, refId);
  }

  async setRefTargets(pairs: Array<{ refId: number; symbolId: number }>): Promise<void> {
    this.ensure();
    const stmt = this.db.prepare("UPDATE code_refs SET to_symbol_id = ? WHERE id = ?");
    this.db.transaction(() => { for (const p of pairs) stmt.run(p.symbolId, p.refId); })();
  }

  async unresolvedRefIds(repoRoot: string): Promise<number[]> {
    this.ensure();
    return (this.db
      .prepare("SELECT id FROM code_refs WHERE repo_root = ? AND to_symbol_id IS NULL")
      .all(repoRoot) as Array<{ id: number }>).map((r) => r.id);
  }

  async allSymbols(repoRoot: string): Promise<SymbolRow[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        `SELECT s.*, cf.path AS file FROM code_symbols s
         JOIN code_files cf ON cf.id = s.file_id
         WHERE s.repo_root = ? ORDER BY cf.path, s.start_line`
      )
      .all(repoRoot) as Array<SymDbRow & { file: string }>;
    return rows.map(mapSymbol);
  }

  async stats(repoRoot: string): Promise<CodeGraphStats> {
    this.ensure();
    const db = this.db;
    const one = (sql: string) => (db.prepare(sql).get(repoRoot) as { n: number | null }).n ?? 0;
    const byLang = db
      .prepare("SELECT language, COUNT(*) AS n FROM code_files WHERE repo_root = ? GROUP BY language")
      .all(repoRoot) as Array<{ language: string; n: number }>;
    const last = db
      .prepare("SELECT MAX(indexed_at) AS n FROM code_files WHERE repo_root = ?")
      .get(repoRoot) as { n: number | null };
    return {
      files: one("SELECT COUNT(*) AS n FROM code_files WHERE repo_root = ?"),
      symbols: one("SELECT COUNT(*) AS n FROM code_symbols WHERE repo_root = ?"),
      refs: one("SELECT COUNT(*) AS n FROM code_refs WHERE repo_root = ?"),
      resolvedRefs: one("SELECT COUNT(*) AS n FROM code_refs WHERE repo_root = ? AND to_symbol_id IS NOT NULL"),
      byLanguage: Object.fromEntries(byLang.map((r) => [r.language, r.n])),
      lastIndexedAt: last.n,
    };
  }

  async getSummary(repoRoot: string, key: string): Promise<SummaryRow | null> {
    this.ensure();
    const r = this.db.prepare("SELECT * FROM code_summaries WHERE repo_root = ? AND key = ?").get(repoRoot, key) as SumDbRow | undefined;
    return r ? mapSummary(r) : null;
  }

  async upsertSummary(repoRoot: string, s: SummaryRow): Promise<void> {
    this.ensure();
    this.db.prepare(
      `INSERT INTO code_summaries (repo_root, key, kind, path, summary, model, source_hash, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_root, key) DO UPDATE SET kind = excluded.kind, path = excluded.path, summary = excluded.summary,
         model = excluded.model, source_hash = excluded.source_hash, generated_at = excluded.generated_at`
    ).run(repoRoot, s.key, s.kind, s.path, s.summary, s.model, s.sourceHash, s.generatedAt);
  }

  async listSummaries(repoRoot: string): Promise<SummaryRow[]> {
    this.ensure();
    return (this.db.prepare("SELECT * FROM code_summaries WHERE repo_root = ? ORDER BY key").all(repoRoot) as SumDbRow[]).map(mapSummary);
  }

  async pruneSummaries(repoRoot: string, keep: string[]): Promise<number> {
    this.ensure();
    const keepSet = new Set(keep);
    const del = this.db.prepare("DELETE FROM code_summaries WHERE repo_root = ? AND key = ?");
    let n = 0;
    for (const r of await this.listSummaries(repoRoot)) if (!keepSet.has(r.key)) n += del.run(repoRoot, r.key).changes;
    return n;
  }

  async syncTriples(scope: string, desired: TripleSpec[]): Promise<{ added: number; closed: number; kept: number }> {
    this.ensure();
    const key = (t: { subject: string; predicate: string; object: string }) => `${t.subject}\u0000${t.predicate}\u0000${t.object}`;
    // dedupe the desired set by (subject, predicate, object) before anything else
    const want = new Map(desired.map((t) => [key(t), t]));
    const open = this.db
      .prepare("SELECT id, subject, predicate, object FROM kg_triples WHERE source_session = ? AND valid_to IS NULL")
      .all(scope) as Array<{ id: number; subject: string; predicate: string; object: string }>;
    const have = new Set<string>();
    const now = Date.now();
    let added = 0, closed = 0, kept = 0;
    const close = this.db.prepare("UPDATE kg_triples SET valid_to = ? WHERE id = ?");
    const ins = this.db.prepare(
      "INSERT INTO kg_triples (subject, predicate, object, project_id, source_session, valid_from, confidence, created_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    this.db.transaction(() => {
      for (const r of open) {
        const k = key(r);
        if (want.has(k) && !have.has(k)) { have.add(k); kept++; } else { close.run(now, r.id); closed++; }
      }
      // a duplicate (subject, predicate, object) already open in ANOTHER scope: keep the existing row.
      const otherOpen = this.db
        .prepare("SELECT subject, predicate, object FROM kg_triples WHERE valid_to IS NULL AND NOT (source_session IS ?)")
        .all(scope) as Array<{ subject: string; predicate: string; object: string }>;
      const dk = new Set(otherOpen.map((d) => key(d)));
      // history rows of THIS scope stay closed (that is the audit trail); reopen only foreign history.
      const findClosed = this.db.prepare("SELECT id FROM kg_triples WHERE valid_to IS NOT NULL AND subject = ? AND predicate = ? AND object = ? AND NOT (source_session IS ?) ORDER BY valid_to DESC LIMIT 1");
      const reopen = this.db.prepare("UPDATE kg_triples SET valid_to = NULL, valid_from = ?, source_session = ?, confidence = ? WHERE id = ?");
      for (const [k, t] of want) {
        if (have.has(k)) continue;
        // owned OPEN by another scope: keep that row, add nothing. Otherwise a triple with closed
        // history (this scope's own vanish, or another scope's closed twin) reopens IN PLACE — the
        // open-unique index forbids a second open row anyway; only never-seen triples insert fresh.
        if (dk.has(k)) continue;
        const prior = findClosed.get(t.subject, t.predicate, t.object, scope) as { id: number } | undefined;
        if (prior) reopen.run(now, scope, t.confidence, prior.id);
        else ins.run(t.subject, t.predicate, t.object, t.projectId ?? null, scope, now, t.confidence, now);
        dk.add(k); // one open row per triple: a repeat of the same key in this batch never re-adds
        added++;
      }
    })();
    return { added, closed, kept };
  }

  async triplesTouching(keys: string[], opts?: { limit?: number; includeClosed?: boolean }): Promise<TripleRow[]> {
    this.ensure();
    if (keys.length === 0) return [];
    const ph = keys.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM kg_triples WHERE (subject IN (${ph}) OR object IN (${ph}))${opts?.includeClosed ? "" : " AND valid_to IS NULL"}
         AND source_session LIKE 'relate:%' ORDER BY id LIMIT ?`,
      )
      .all(...keys, ...keys, opts?.limit ?? 500) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number, subject: r.subject as string, predicate: r.predicate as string, object: r.object as string,
      confidence: r.confidence as "EXTRACTED" | "INFERRED", projectId: (r.project_id as number | null) ?? null,
      validFrom: r.valid_from as number, validTo: (r.valid_to as number | null) ?? null,
    }));
  }

  async tripleCounts(): Promise<Record<string, { open: number; closed: number }>> {
    this.ensure();
    // DISTINCT(valid_to) collapses the value, not the rows — it reported every triple as open.
    const rows = this.db
      .prepare("SELECT predicate, SUM(CASE WHEN valid_to IS NULL THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN valid_to IS NOT NULL THEN 1 ELSE 0 END) AS closed FROM kg_triples WHERE source_session LIKE 'relate:%' GROUP BY predicate")
      .all() as Array<{ predicate: string; open: number; closed: number }>;
    return Object.fromEntries(rows.map((r) => [r.predicate, { open: r.open, closed: r.closed }]));
  }
}
