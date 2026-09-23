/**
 * Temporal Knowledge Graph — kg_triples types.
 *
 * Triples are time-scoped: valid_from/valid_to enable point-in-time queries.
 * Invalidation sets valid_to = NOW() instead of deleting rows.
 *
 * CRUD lives behind StorageBackend (src/storage/postgres/kg-triples.ts) —
 * this module only defines the shared shapes so callers and the storage
 * layer agree on them without either side importing SQL.
 */

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
