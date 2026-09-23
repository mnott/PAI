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

// SQLite's kg_entities CRUD (upsertKgEntity/findKgEntity/listKgEntities/
// updateEntityFeedbackWeight) lives in storage/sqlite/kg-entity.ts —
// PostgresBackend implements the same operations inline against its own
// pool, so there is no cross-backend function to share here.
