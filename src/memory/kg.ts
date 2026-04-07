/**
 * Temporal Knowledge Graph — kg_triples CRUD layer.
 *
 * Uses the Postgres connection pool from the storage backend.
 * Triples are time-scoped: valid_from/valid_to enable point-in-time queries.
 * Invalidation sets valid_to = NOW() instead of deleting rows.
 */

import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KgTriple {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  project_id?: number;
  source_session?: string;
  valid_from: Date;
  valid_to?: Date;
  confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  created_at: Date;
}

export interface KgAddParams {
  subject: string;
  predicate: string;
  object: string;
  project_id?: number;
  source_session?: string;
  confidence?: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
}

export interface KgQueryParams {
  subject?: string;
  predicate?: string;
  object?: string;
  project_id?: number;
  as_of?: Date;
  include_invalidated?: boolean;
}

export interface KgContradiction {
  subject: string;
  predicate: string;
  objects: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Add a new triple to the knowledge graph.
 * Returns the inserted triple.
 */
export async function kgAdd(pool: Pool, params: KgAddParams): Promise<KgTriple> {
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
export async function kgQuery(pool: Pool, params: KgQueryParams): Promise<KgTriple[]> {
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

/**
 * Invalidate a triple by setting valid_to = NOW().
 * Does not delete the row — preserves history.
 */
export async function kgInvalidate(pool: Pool, tripleId: number): Promise<void> {
  await pool.query(
    `UPDATE kg_triples SET valid_to = NOW() WHERE id = $1 AND valid_to IS NULL`,
    [tripleId]
  );
}

/**
 * Find contradictions: cases where the same (subject, predicate) pair has
 * multiple currently-valid objects.
 */
export async function kgContradictions(
  pool: Pool,
  subject: string
): Promise<KgContradiction[]> {
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
