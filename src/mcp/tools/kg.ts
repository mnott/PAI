/**
 * MCP tool handlers for the temporal knowledge graph.
 *
 * Tools:
 *   kg_add            — insert a new (subject, predicate, object) triple
 *   kg_query          — query triples with optional temporal filter
 *   kg_invalidate     — mark a triple as no longer valid (sets valid_to)
 *   kg_contradictions — find (subject, predicate) pairs with multiple valid objects
 */

import type { Pool } from "pg";
import type { ToolResult } from "./types.js";
import {
  kgAdd,
  kgQuery,
  kgInvalidate,
  kgContradictions,
} from "../../memory/kg.js";

// ---------------------------------------------------------------------------
// Tool: kg_add
// ---------------------------------------------------------------------------

export interface KgAddToolParams {
  subject: string;
  predicate: string;
  object: string;
  project_id?: number;
  source_session?: string;
  confidence?: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
}

export async function toolKgAdd(
  pool: Pool,
  params: KgAddToolParams
): Promise<ToolResult> {
  try {
    if (!params.subject || !params.predicate || !params.object) {
      return {
        content: [{ type: "text", text: "kg_add error: subject, predicate, and object are required" }],
        isError: true,
      };
    }
    const triple = await kgAdd(pool, params);
    return {
      content: [{ type: "text", text: JSON.stringify(triple, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `kg_add error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: kg_query
// ---------------------------------------------------------------------------

export interface KgQueryToolParams {
  subject?: string;
  predicate?: string;
  object?: string;
  project_id?: number;
  as_of?: string; // ISO 8601 string; converted to Date
  include_invalidated?: boolean;
}

export async function toolKgQuery(
  pool: Pool,
  params: KgQueryToolParams
): Promise<ToolResult> {
  try {
    const asOf = params.as_of ? new Date(params.as_of) : undefined;
    if (asOf && isNaN(asOf.getTime())) {
      return {
        content: [{ type: "text", text: `kg_query error: invalid as_of date: ${params.as_of}` }],
        isError: true,
      };
    }
    const triples = await kgQuery(pool, {
      subject: params.subject,
      predicate: params.predicate,
      object: params.object,
      project_id: params.project_id,
      as_of: asOf,
      include_invalidated: params.include_invalidated,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(triples, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `kg_query error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: kg_invalidate
// ---------------------------------------------------------------------------

export interface KgInvalidateToolParams {
  triple_id: number;
}

export async function toolKgInvalidate(
  pool: Pool,
  params: KgInvalidateToolParams
): Promise<ToolResult> {
  try {
    if (params.triple_id === undefined || params.triple_id === null) {
      return {
        content: [{ type: "text", text: "kg_invalidate error: triple_id is required" }],
        isError: true,
      };
    }
    await kgInvalidate(pool, params.triple_id);
    return {
      content: [{ type: "text", text: JSON.stringify({ invalidated: true, triple_id: params.triple_id }) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `kg_invalidate error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: kg_contradictions
// ---------------------------------------------------------------------------

export interface KgContradictionsToolParams {
  subject: string;
}

export async function toolKgContradictions(
  pool: Pool,
  params: KgContradictionsToolParams
): Promise<ToolResult> {
  try {
    if (!params.subject) {
      return {
        content: [{ type: "text", text: "kg_contradictions error: subject is required" }],
        isError: true,
      };
    }
    const contradictions = await kgContradictions(pool, params.subject);
    return {
      content: [{ type: "text", text: JSON.stringify(contradictions, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `kg_contradictions error: ${String(e)}` }],
      isError: true,
    };
  }
}
