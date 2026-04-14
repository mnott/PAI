/**
 * kg-entity.ts — Entity content-addressing with multi-tenant support.
 *
 * Provides UUID5-style deterministic content hashes for KG entities and edges,
 * ensuring that the same entity name always maps to the same ID within a tenant.
 * This enables idempotent upserts and stable foreign keys for kg_triples.
 *
 * Multi-tenant support: each tenant namespace gets its own entity ID space.
 * The default tenant is "default" for single-user deployments.
 */

import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KgEntity {
  entity_id: string;
  tenant_id: string;
  name: string;
  type: string;
  description?: string;
  first_seen?: number;
  last_seen?: number;
  mention_count: number;
  feedback_weight: number;
}

export interface KgEntityUpsertParams {
  name: string;
  type?: string;
  description?: string;
  tenantId?: string;
}

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic entity ID (UUID5-style) for a given name and tenant.
 *
 * The ID is a hex digest derived from "tenant_id:name" so the same entity
 * always receives the same ID within a tenant namespace.
 *
 * @param name      Entity name (case-preserved)
 * @param tenantId  Tenant namespace (default: "default")
 */
export function entityContentId(name: string, tenantId = "default"): string {
  return createHash("sha256")
    .update(`entity:${tenantId}:${name}`)
    .digest("hex")
    .slice(0, 32); // 128-bit hex string — UUID5-compatible length
}

/**
 * Generate a deterministic edge ID for a (source, relation, target) triple
 * within a tenant namespace.
 *
 * @param source    Source entity name
 * @param relation  Relation/predicate verb phrase
 * @param target    Target entity name
 * @param tenantId  Tenant namespace (default: "default")
 */
export function edgeContentId(
  source: string,
  relation: string,
  target: string,
  tenantId = "default"
): string {
  return createHash("sha256")
    .update(`edge:${tenantId}:${source}:${relation}:${target}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// SQLite entity upsert (for federation.db)
// ---------------------------------------------------------------------------

/**
 * Upsert a KG entity in the federation SQLite database.
 *
 * If the entity already exists for this tenant:
 *   - Updates last_seen to now
 *   - Increments mention_count
 *   - Updates description if provided (overwrites older description)
 *
 * Returns the entity_id for use as a foreign key in kg_triples.
 */
export function upsertKgEntity(
  db: Database,
  params: KgEntityUpsertParams
): string {
  const tenantId = params.tenantId ?? "default";
  const entityId = entityContentId(params.name, tenantId);
  const now = Date.now();

  db.prepare(`
    INSERT INTO kg_entities
      (entity_id, tenant_id, name, type, description, first_seen, last_seen, mention_count, feedback_weight)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 1, 0.5)
    ON CONFLICT(entity_id) DO UPDATE SET
      last_seen     = excluded.last_seen,
      mention_count = mention_count + 1,
      description   = COALESCE(excluded.description, description),
      type          = CASE WHEN excluded.type != 'unknown' THEN excluded.type ELSE type END
  `).run(
    entityId,
    tenantId,
    params.name,
    params.type ?? "unknown",
    params.description ?? null,
    now,
    now
  );

  return entityId;
}

/**
 * Look up a KG entity by name within a tenant.
 * Returns null if the entity does not exist.
 */
export function findKgEntity(
  db: Database,
  name: string,
  tenantId = "default"
): KgEntity | null {
  const entityId = entityContentId(name, tenantId);
  const row = db.prepare(
    "SELECT * FROM kg_entities WHERE entity_id = ? AND tenant_id = ?"
  ).get(entityId, tenantId) as KgEntity | undefined;
  return row ?? null;
}

/**
 * List KG entities for a tenant, optionally filtered by type.
 *
 * @param db        Federation SQLite database
 * @param tenantId  Tenant namespace (default: "default")
 * @param type      Optional entity type filter
 * @param limit     Maximum entities to return (default: 100)
 */
export function listKgEntities(
  db: Database,
  tenantId = "default",
  type?: string,
  limit = 100
): KgEntity[] {
  if (type) {
    return db.prepare(
      "SELECT * FROM kg_entities WHERE tenant_id = ? AND type = ? ORDER BY mention_count DESC LIMIT ?"
    ).all(tenantId, type, limit) as KgEntity[];
  }
  return db.prepare(
    "SELECT * FROM kg_entities WHERE tenant_id = ? ORDER BY mention_count DESC LIMIT ?"
  ).all(tenantId, limit) as KgEntity[];
}

// ---------------------------------------------------------------------------
// Feedback weight update (MR2 — EMA)
// ---------------------------------------------------------------------------

/**
 * Apply an EMA (Exponential Moving Average) feedback update to an entity's weight.
 *
 * EMA formula: new_weight = old_weight + alpha * (target - old_weight)
 *
 * @param db            Federation SQLite database
 * @param entityId      Entity ID to update
 * @param normalizedRating  Rating normalized to [0, 1] (e.g., rating/5 for 1-5 scale)
 * @param alpha         EMA learning rate (default: 0.1)
 */
export function updateEntityFeedbackWeight(
  db: Database,
  entityId: string,
  normalizedRating: number,
  alpha = 0.1
): void {
  const row = db.prepare(
    "SELECT feedback_weight FROM kg_entities WHERE entity_id = ?"
  ).get(entityId) as { feedback_weight: number } | undefined;

  if (!row) return;

  const newWeight = row.feedback_weight + alpha * (normalizedRating - row.feedback_weight);
  db.prepare(
    "UPDATE kg_entities SET feedback_weight = ? WHERE entity_id = ?"
  ).run(newWeight, entityId);
}
