/**
 * SQLite kg_entities CRUD — moved from memory/kg-entity.ts so the only file
 * running raw SQL against kg_entities lives under src/storage/. The pure
 * content-addressing helpers (entityContentId/edgeContentId) and the
 * KgEntity/KgEntityUpsertParams types they share with PostgresBackend stay
 * in memory/kg-entity.ts.
 */

import type { Database } from "better-sqlite3";
import { entityContentId, type KgEntity, type KgEntityUpsertParams } from "../../memory/kg-entity.js";

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
export function upsertKgEntitySqlite(
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
export function findKgEntitySqlite(
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
 */
export function listKgEntitiesSqlite(
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

/**
 * Apply an EMA (Exponential Moving Average) feedback update to an entity's weight.
 *
 * EMA formula: new_weight = old_weight + alpha * (target - old_weight)
 */
export function updateEntityFeedbackWeightSqlite(
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
