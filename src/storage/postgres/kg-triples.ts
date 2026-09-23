/**
 * Postgres implementation of the temporal knowledge graph (kg_triples).
 * Delegated from PostgresBackend — see src/storage/interface.ts for the
 * StorageBackend contract these functions satisfy.
 */

import type { Pool } from "pg";
import type { KgAddParams, KgQueryParams, KgTriple, KgContradiction } from "../../memory/kg.js";
import type { KgStats } from "../interface.js";

function rowToTriple(row: Record<string, unknown>): KgTriple {
  return {
    id: row.id as number,
    subject: row.subject as string,
    predicate: row.predicate as string,
    object: row.object as string,
    project_id: row.project_id as number | undefined,
    source_session: row.source_session as string | undefined,
    valid_from: new Date(row.valid_from as string),
    valid_to: row.valid_to ? new Date(row.valid_to as string) : undefined,
    confidence: row.confidence as "EXTRACTED" | "INFERRED" | "AMBIGUOUS",
    created_at: new Date(row.created_at as string),
  };
}

export async function addKgTriple(pool: Pool, params: KgAddParams): Promise<KgTriple> {
  const confidence = params.confidence ?? "EXTRACTED";
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO kg_triples
       (subject, predicate, object, project_id, source_session, confidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.subject,
      params.predicate,
      params.object,
      params.project_id ?? null,
      params.source_session ?? null,
      confidence,
    ]
  );
  return rowToTriple(result.rows[0]);
}

/**
 * Query triples by subject, predicate, object, and/or project.
 * Supports point-in-time queries via as_of.
 * By default only returns currently-valid triples (valid_to IS NULL).
 */
export async function queryKgTriples(pool: Pool, params: KgQueryParams): Promise<KgTriple[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.subject !== undefined) {
    conditions.push(`subject = $${idx++}`);
    values.push(params.subject);
  }
  if (params.predicate !== undefined) {
    conditions.push(`predicate = $${idx++}`);
    values.push(params.predicate);
  }
  if (params.object !== undefined) {
    conditions.push(`object = $${idx++}`);
    values.push(params.object);
  }
  if (params.project_id !== undefined) {
    conditions.push(`project_id = $${idx++}`);
    values.push(params.project_id);
  }

  if (params.as_of !== undefined) {
    // Valid at the given timestamp: started before or at as_of, and not yet ended
    conditions.push(`valid_from <= $${idx++}`);
    values.push(params.as_of);
    conditions.push(`(valid_to IS NULL OR valid_to > $${idx++})`);
    values.push(params.as_of);
  } else if (!params.include_invalidated) {
    // Default: only currently-valid (no valid_to set)
    conditions.push(`valid_to IS NULL`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM kg_triples ${where} ORDER BY valid_from DESC`,
    values
  );
  return result.rows.map(rowToTriple);
}

/** Invalidate a triple by setting valid_to = NOW(). Does not delete the row — preserves history. */
export async function invalidateKgTriple(pool: Pool, tripleId: number): Promise<void> {
  await pool.query(
    `UPDATE kg_triples SET valid_to = NOW() WHERE id = $1 AND valid_to IS NULL`,
    [tripleId]
  );
}

/**
 * Find contradictions: cases where the same (subject, predicate) pair has
 * multiple currently-valid objects.
 */
export async function getKgContradictions(pool: Pool, subject: string): Promise<KgContradiction[]> {
  const result = await pool.query<{ subject: string; predicate: string; objects: string[] }>(
    `SELECT subject, predicate, array_agg(object ORDER BY object) AS objects
     FROM kg_triples
     WHERE subject = $1
       AND valid_to IS NULL
     GROUP BY subject, predicate
     HAVING COUNT(*) > 1`,
    [subject]
  );
  return result.rows.map((row) => ({
    subject: row.subject,
    predicate: row.predicate,
    objects: row.objects,
  }));
}

export async function getKgStats(pool: Pool): Promise<KgStats> {
  const totals = await pool.query<{
    total: string;
    valid: string;
    invalidated: string;
    subjects: string;
    predicates: string;
  }>(
    `SELECT
       COUNT(*)::text                                            AS total,
       COUNT(*) FILTER (WHERE valid_to IS NULL)::text            AS valid,
       COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::text        AS invalidated,
       COUNT(DISTINCT subject)::text                             AS subjects,
       COUNT(DISTINCT predicate)::text                           AS predicates
     FROM kg_triples`
  );

  const contradictions = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM (
       SELECT subject, predicate
       FROM kg_triples
       WHERE valid_to IS NULL
       GROUP BY subject, predicate
       HAVING COUNT(*) > 1
     ) c`
  );

  const row = totals.rows[0];
  return {
    total: parseInt(row?.total ?? "0", 10),
    valid: parseInt(row?.valid ?? "0", 10),
    invalidated: parseInt(row?.invalidated ?? "0", 10),
    subjects: parseInt(row?.subjects ?? "0", 10),
    predicates: parseInt(row?.predicates ?? "0", 10),
    contradictions: parseInt(contradictions.rows[0]?.count ?? "0", 10),
  };
}
