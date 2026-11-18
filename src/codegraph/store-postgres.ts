/**
 * Postgres implementation of CodeGraphStore.
 *
 * Full-text search uses the generated tsvector column (GIN indexed, 'simple'
 * config) over code_symbols.search_text — the sub-word expanded identifier
 * text — with the same OR-of-quoted-terms tsquery building the memory search
 * uses (storage/postgres/helpers.ts buildPgTsQuery).
 */

import type { Pool } from "pg";
import { ensureCodeGraphSchemaPostgres } from "./schema-postgres.js";
import { symbolFtsText, splitIdentifierWords } from "./fts.js";
import type {
  CodeGraphStore, CodeFileRow, CodeGraphStats, FileRecord, RefRow,
  ResolvedRefRow, SymbolRow, TripleSpec, TripleRow,
} from "./store.js";

interface SymDbRow {
  id: number; name: string; qualified_name: string; kind: string;
  file: string; file_id: number; start_line: number; end_line: number;
  signature: string; exported: boolean;
}
interface RefDbRow {
  id: number; kind: string; line: number; to_name: string; to_symbol_id: number | null;
  from_file: string; from_symbol: string | null;
  t_name: string | null; t_qualified_name: string | null; t_kind: string | null;
  t_file: string | null; t_file_id: number | null; t_start_line: number | null;
  t_end_line: number | null; t_signature: string | null; t_exported: boolean | null;
}

function mapSymbol(r: SymDbRow): SymbolRow {
  return {
    id: r.id, name: r.name, qualifiedName: r.qualified_name, kind: r.kind,
    file: r.file, fileId: r.file_id, startLine: r.start_line, endLine: r.end_line,
    signature: r.signature, exported: r.exported,
  };
}

function mapRef(r: RefDbRow): ResolvedRefRow {
  const target: SymbolRow | null =
    r.to_symbol_id == null || r.t_name == null
      ? null
      : {
          id: r.to_symbol_id, name: r.t_name, qualifiedName: r.t_qualified_name!, kind: r.t_kind!,
          file: r.t_file!, fileId: r.t_file_id!, startLine: r.t_start_line!, endLine: r.t_end_line!,
          signature: r.t_signature!, exported: !!r.t_exported,
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

/** tsquery for a symbol search: OR of quoted sub-word terms, same shape as memory search. */
export function buildSymbolTsQuery(query: string): string {
  const words = [...new Set(splitIdentifierWords(query))];
  return words.map((t) => `'${t.replace(/'/g, "''")}'`).join(" | ");
}

export class PostgresCodeGraphStore implements CodeGraphStore {
  private pool: Pool;
  private ready: Promise<void> | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private ensure(): Promise<void> {
    if (!this.ready) this.ready = ensureCodeGraphSchemaPostgres(this.pool);
    return this.ready;
  }

  async upsertFile(repoRoot: string, file: FileRecord): Promise<{ fileId: number; brokenRefIds: number[] }> {
    await this.ensure();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: number }>(
        "SELECT id FROM code_files WHERE repo_root = $1 AND path = $2",
        [repoRoot, file.path],
      );
      let brokenRefIds: number[] = [];
      if (existing.rowCount) {
        const fileId = existing.rows[0].id;
        const broken = await client.query<{ id: number }>(
          `SELECT cr.id FROM code_refs cr JOIN code_symbols s ON s.id = cr.to_symbol_id WHERE s.file_id = $1`,
          [fileId],
        );
        brokenRefIds = broken.rows.map((r) => r.id);
        await client.query("DELETE FROM code_files WHERE id = $1", [fileId]);
      }

      const ins = await client.query<{ id: number }>(
        `INSERT INTO code_files (repo_root, path, language, content_hash, mtime, size, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [repoRoot, file.path, file.language, file.contentHash, file.mtime, file.size, Date.now()],
      );
      const fileId = ins.rows[0].id;

      // multi-row INSERTs, chunked under the 65535 bind-parameter limit
      const symbolIds: number[] = [];
      for (let i = 0; i < file.symbols.length; i += 500) {
        const chunk = file.symbols.slice(i, i + 500);
        const params: unknown[] = [];
        const rows = chunk.map((s, j) => {
          const o = j * 10;
          params.push(repoRoot, fileId, s.name, s.qualifiedName, s.kind, s.startLine, s.endLine, s.signature, s.exported,
            symbolFtsText(s.name, s.qualifiedName, s.signature));
          return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`;
        });
        const r = await client.query<{ id: number }>(
          `INSERT INTO code_symbols (repo_root, file_id, name, qualified_name, kind, start_line, end_line, signature, exported, search_text)
           VALUES ${rows.join(",")} RETURNING id`,
          params,
        );
        // RETURNING follows VALUES order for a plain multi-row INSERT
        for (const row of r.rows) symbolIds.push(row.id);
      }

      for (let i = 0; i < file.refs.length; i += 1000) {
        const chunk = file.refs.slice(i, i + 1000);
        const params: unknown[] = [];
        const rows = chunk.map((ref, j) => {
          const o = j * 6;
          const fromSymbolId = ref.fromSymbolIndex != null ? symbolIds[ref.fromSymbolIndex] ?? null : null;
          params.push(repoRoot, fileId, fromSymbolId, ref.toName, ref.kind, ref.line);
          return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`;
        });
        await client.query(
          `INSERT INTO code_refs (repo_root, from_file_id, from_symbol_id, to_name, kind, line) VALUES ${rows.join(",")}`,
          params,
        );
      }

      await client.query("COMMIT");
      return { fileId, brokenRefIds };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* dead connection */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteFiles(repoRoot: string, paths: string[]): Promise<{ brokenRefIds: number[] }> {
    await this.ensure();
    if (paths.length === 0) return { brokenRefIds: [] };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const broken = await client.query<{ id: number }>(
        `SELECT cr.id FROM code_refs cr
         JOIN code_symbols s ON s.id = cr.to_symbol_id
         WHERE s.file_id IN (SELECT id FROM code_files WHERE repo_root = $1 AND path = ANY($2::text[]))`,
        [repoRoot, paths],
      );
      await client.query("DELETE FROM code_files WHERE repo_root = $1 AND path = ANY($2::text[])", [repoRoot, paths]);
      await client.query("COMMIT");
      return { brokenRefIds: broken.rows.map((r) => r.id) };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* dead connection */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async touchFileMtime(repoRoot: string, path: string, mtime: number, size: number): Promise<void> {
    await this.ensure();
    await this.pool.query(
      "UPDATE code_files SET mtime = $1, size = $2, indexed_at = $3 WHERE repo_root = $4 AND path = $5",
      [mtime, size, Date.now(), repoRoot, path],
    );
  }

  async listFiles(repoRoot: string): Promise<CodeFileRow[]> {
    await this.ensure();
    const r = await this.pool.query(
      "SELECT id, path, language, content_hash, mtime, size, indexed_at FROM code_files WHERE repo_root = $1 ORDER BY path",
      [repoRoot],
    );
    return r.rows.map((x) => ({
      id: x.id, path: x.path, language: x.language, contentHash: x.content_hash,
      mtime: Number(x.mtime), size: x.size, indexedAt: Number(x.indexed_at),
    }));
  }

  async resolveRefs(repoRoot: string, paths: string[]): Promise<ResolvedRefRow[]> {
    await this.ensure();
    if (paths.length === 0) return [];
    const r = await this.pool.query(`${REF_SELECT} WHERE cf.repo_root = $1 AND cf.path = ANY($2::text[]) ORDER BY cr.id`, [repoRoot, paths]);
    return r.rows.map(mapRef);
  }

  async unresolvedRefsInFiles(repoRoot: string, paths: string[]): Promise<ResolvedRefRow[]> {
    await this.ensure();
    const params: Array<string | string[]> = [repoRoot];
    let sql = `${REF_SELECT} WHERE cr.repo_root = $1 AND cr.to_symbol_id IS NULL`;
    if (paths.length > 0) {
      params.push(paths);
      sql += ` AND cf.path = ANY($${params.length}::text[])`;
    }
    const r = await this.pool.query(`${sql} ORDER BY cr.id`, params);
    return r.rows.map(mapRef);
  }

  async searchSymbols(repoRoot: string, query: string, limit = 20): Promise<SymbolRow[]> {
    await this.ensure();
    const tsQuery = buildSymbolTsQuery(query);
    if (!tsQuery) return [];
    const r = await this.pool.query(
      `SELECT s.id, s.name, s.qualified_name, s.kind, cf.path AS file, s.file_id,
              s.start_line, s.end_line, s.signature, s.exported
       FROM code_symbols s
       JOIN code_files cf ON cf.id = s.file_id
       WHERE s.repo_root = $1 AND s.fts_vector @@ to_tsquery('simple', $2)
       ORDER BY ts_rank(s.fts_vector, to_tsquery('simple', $2)) DESC, s.name
       LIMIT $3`,
      [repoRoot, tsQuery, limit],
    );
    return r.rows.map(mapSymbol);
  }

  async symbolsByName(repoRoot: string, name: string, limit = 50): Promise<SymbolRow[]> {
    await this.ensure();
    const r = await this.pool.query(
      `SELECT s.id, s.name, s.qualified_name, s.kind, cf.path AS file, s.file_id,
              s.start_line, s.end_line, s.signature, s.exported
       FROM code_symbols s
       JOIN code_files cf ON cf.id = s.file_id
       WHERE s.repo_root = $1 AND (s.name = $2 OR s.qualified_name = $2)
       ORDER BY s.exported DESC, s.start_line LIMIT $3`,
      [repoRoot, name, limit],
    );
    return r.rows.map(mapSymbol);
  }

  async symbolsInFile(repoRoot: string, path: string): Promise<SymbolRow[]> {
    await this.ensure();
    const r = await this.pool.query(
      `SELECT s.id, s.name, s.qualified_name, s.kind, cf.path AS file, s.file_id,
              s.start_line, s.end_line, s.signature, s.exported
       FROM code_symbols s
       JOIN code_files cf ON cf.id = s.file_id
       WHERE s.repo_root = $1 AND cf.path = $2 ORDER BY s.start_line`,
      [repoRoot, path],
    );
    return r.rows.map(mapSymbol);
  }

  async callers(symbolId: number): Promise<RefRow[]> {
    await this.ensure();
    const r = await this.pool.query(`${REF_SELECT} WHERE cr.to_symbol_id = $1 ORDER BY cf.path, cr.line`, [symbolId]);
    return r.rows.map(mapRef);
  }

  async callersByName(repoRoot: string, name: string, limit = 50): Promise<ResolvedRefRow[]> {
    await this.ensure();
    const r = await this.pool.query(`${REF_SELECT} WHERE cr.repo_root = $1 AND cr.to_name = $2 ORDER BY cf.path, cr.line LIMIT $3`, [repoRoot, name, limit]);
    return r.rows.map(mapRef);
  }

  async callees(symbolId: number): Promise<ResolvedRefRow[]> {
    await this.ensure();
    const r = await this.pool.query(`${REF_SELECT} WHERE cr.from_symbol_id = $1 ORDER BY cr.line`, [symbolId]);
    return r.rows.map(mapRef);
  }

  async calleesByName(repoRoot: string, name: string, limit = 50): Promise<ResolvedRefRow[]> {
    await this.ensure();
    const r = await this.pool.query(`${REF_SELECT} WHERE cr.repo_root = $1 AND fs.qualified_name = $2 ORDER BY cr.line LIMIT $3`, [repoRoot, name, limit]);
    return r.rows.map(mapRef);
  }

  async refsToFiles(repoRoot: string, paths: string[]): Promise<Array<{ fromFile: string; toFile: string }>> {
    await this.ensure();
    if (paths.length === 0) return [];
    const r = await this.pool.query(
      `SELECT DISTINCT cf.path AS "fromFile", tf.path AS "toFile"
       FROM code_refs cr
       JOIN code_symbols ts ON ts.id = cr.to_symbol_id
       JOIN code_files tf ON tf.id = ts.file_id
       JOIN code_files cf ON cf.id = cr.from_file_id
       WHERE cr.repo_root = $1 AND tf.path = ANY($2::text[]) AND cf.path != tf.path`,
      [repoRoot, paths],
    );
    return r.rows;
  }

  async setRefTarget(refId: number, symbolId: number | null): Promise<void> {
    await this.ensure();
    await this.pool.query("UPDATE code_refs SET to_symbol_id = $1 WHERE id = $2", [symbolId, refId]);
  }

  async setRefTargets(pairs: Array<{ refId: number; symbolId: number }>): Promise<void> {
    if (pairs.length === 0) return;
    await this.ensure();
    for (let i = 0; i < pairs.length; i += 5000) {
      const chunk = pairs.slice(i, i + 5000);
      await this.pool.query(
        "UPDATE code_refs SET to_symbol_id = v.sid FROM (SELECT unnest($1::int[]) AS rid, unnest($2::int[]) AS sid) v WHERE code_refs.id = v.rid",
        [chunk.map((x) => x.refId), chunk.map((x) => x.symbolId)],
      );
    }
  }

  async unresolvedRefIds(repoRoot: string): Promise<number[]> {
    await this.ensure();
    const r = await this.pool.query<{ id: number }>("SELECT id FROM code_refs WHERE repo_root = $1 AND to_symbol_id IS NULL", [repoRoot]);
    return r.rows.map((x) => x.id);
  }

  async allSymbols(repoRoot: string): Promise<SymbolRow[]> {
    await this.ensure();
    const r = await this.pool.query(
      `SELECT s.id, s.name, s.qualified_name, s.kind, cf.path AS file, s.file_id,
              s.start_line, s.end_line, s.signature, s.exported
       FROM code_symbols s
       JOIN code_files cf ON cf.id = s.file_id
       WHERE s.repo_root = $1 ORDER BY cf.path, s.start_line`,
      [repoRoot],
    );
    return r.rows.map(mapSymbol);
  }

  async stats(repoRoot: string): Promise<CodeGraphStats> {
    await this.ensure();
    const [files, symbols, refs, resolved, byLang, last] = await Promise.all([
      this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM code_files WHERE repo_root = $1", [repoRoot]),
      this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM code_symbols WHERE repo_root = $1", [repoRoot]),
      this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM code_refs WHERE repo_root = $1", [repoRoot]),
      this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM code_refs WHERE repo_root = $1 AND to_symbol_id IS NOT NULL", [repoRoot]),
      this.pool.query<{ language: string; n: string }>("SELECT language, COUNT(*)::text AS n FROM code_files WHERE repo_root = $1 GROUP BY language", [repoRoot]),
      this.pool.query<{ n: string | null }>("SELECT MAX(indexed_at)::text AS n FROM code_files WHERE repo_root = $1", [repoRoot]),
    ]);
    return {
      files: Number(files.rows[0]?.n ?? 0),
      symbols: Number(symbols.rows[0]?.n ?? 0),
      refs: Number(refs.rows[0]?.n ?? 0),
      resolvedRefs: Number(resolved.rows[0]?.n ?? 0),
      byLanguage: Object.fromEntries(byLang.rows.map((r) => [r.language, Number(r.n)])),
      lastIndexedAt: last.rows[0]?.n != null ? Number(last.rows[0].n) : null,
    };
  }

  async syncTriples(scope: string, desired: TripleSpec[]): Promise<{ added: number; closed: number; kept: number }> {
    await this.ensure();
    const key = (t: { subject: string; predicate: string; object: string }) => `${t.subject}\u0000${t.predicate}\u0000${t.object}`;
    const want = new Map(desired.map((t) => [key(t), t]));
    const open = await this.pool.query<{ id: number; subject: string; predicate: string; object: string }>(
      "SELECT id, subject, predicate, object FROM kg_triples WHERE source_session = $1 AND valid_to IS NULL",
      [scope],
    );
    const have = new Set<string>();
    const closeIds: number[] = [];
    let kept = 0;
    for (const r of open.rows) {
      const k = key(r);
      if (want.has(k) && !have.has(k)) { have.add(k); kept++; } else closeIds.push(r.id);
    }
    const fresh = [...want].filter(([k]) => !have.has(k)).map(([, t]) => t);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (closeIds.length) await client.query("UPDATE kg_triples SET valid_to = NOW() WHERE id = ANY($1::int[])", [closeIds]);
      for (let i = 0; i < fresh.length; i += 500) {
        const c = fresh.slice(i, i + 500);
        await client.query(
          `INSERT INTO kg_triples (subject, predicate, object, project_id, source_session, confidence)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[])`,
          [c.map((t) => t.subject), c.map((t) => t.predicate), c.map((t) => t.object), c.map((t) => t.projectId ?? null), c.map(() => scope), c.map((t) => t.confidence)],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return { added: fresh.length, closed: closeIds.length, kept };
  }

  async triplesTouching(keys: string[], opts?: { limit?: number; includeClosed?: boolean }): Promise<TripleRow[]> {
    await this.ensure();
    if (keys.length === 0) return [];
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT id, subject, predicate, object, project_id, confidence,
              (EXTRACT(EPOCH FROM valid_from) * 1000)::float8 AS vf, (EXTRACT(EPOCH FROM valid_to) * 1000)::float8 AS vt
       FROM kg_triples WHERE (subject = ANY($1::text[]) OR object = ANY($1::text[]))${opts?.includeClosed ? "" : " AND valid_to IS NULL"}
         AND source_session LIKE 'relate:%' ORDER BY id LIMIT $2`,
      [keys, opts?.limit ?? 500],
    );
    return r.rows.map((x) => ({
      id: x.id as number, subject: x.subject as string, predicate: x.predicate as string, object: x.object as string,
      confidence: x.confidence as "EXTRACTED" | "INFERRED", projectId: (x.project_id as number | null) ?? null,
      validFrom: Number(x.vf), validTo: x.vt == null ? null : Number(x.vt),
    }));
  }

  async tripleCounts(): Promise<Record<string, { open: number; closed: number }>> {
    await this.ensure();
    const r = await this.pool.query<{ predicate: string; open: string; closed: string }>(
      `SELECT predicate, COUNT(*) FILTER (WHERE valid_to IS NULL)::text AS open, COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::text AS closed
       FROM kg_triples WHERE source_session LIKE 'relate:%' GROUP BY predicate`,
    );
    return Object.fromEntries(r.rows.map((x) => [x.predicate, { open: Number(x.open), closed: Number(x.closed) }]));
  }
}
