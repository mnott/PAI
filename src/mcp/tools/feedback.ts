/**
 * MCP tool handler: memory_feedback
 *
 * Implements the MR2 feedback weight loop:
 * - Accepts chunk IDs and a rating (1-5)
 * - Applies EMA update to memory_chunks.relevance_score
 * - Finds entity names mentioned in those chunks and updates kg_entities.feedback_weight
 *
 * EMA formula: new = old + alpha * (normalized_rating - old)
 * where normalized_rating = (rating - 1) / 4  →  maps [1,5] to [0,1]
 * and alpha = 0.1
 *
 * Integration into search scoring:
 *   final_score *= (0.5 + relevance_score)
 * This multiplier ranges from 0.5 (relevance_score=0) to 1.5 (relevance_score=1),
 * giving a ±50% boost/penalty based on accumulated feedback.
 */

import type { ToolResult } from "./types.js";
import type { StorageBackend } from "../../storage/interface.js";

// EMA learning rate
const FEEDBACK_ALPHA = 0.1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFeedbackParams {
  /** Array of chunk IDs to apply feedback to */
  chunk_ids: string[];
  /** Rating from 1 (not relevant) to 5 (highly relevant) */
  rating: number;
  /** Optional tenant ID for entity feedback scoping. Default: "default" */
  tenant_id?: string;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Apply relevance feedback to memory chunks and associated KG entities.
 * Both memory_chunks.relevance_score and kg_entities.feedback_weight go
 * through the passed StorageBackend, so this works on either backend.
 *
 * @param backend  StorageBackend for both the chunk and kg_entities portions
 * @param params   Feedback parameters
 */
export async function toolMemoryFeedback(
  backend: StorageBackend,
  params: MemoryFeedbackParams
): Promise<ToolResult> {
  try {
    if (!Array.isArray(params.chunk_ids) || params.chunk_ids.length === 0) {
      return {
        content: [{ type: "text", text: "memory_feedback error: chunk_ids must be a non-empty array" }],
        isError: true,
      };
    }

    const rating = params.rating;
    if (typeof rating !== "number" || rating < 1 || rating > 5) {
      return {
        content: [{ type: "text", text: "memory_feedback error: rating must be a number between 1 and 5" }],
        isError: true,
      };
    }

    // Normalize rating [1,5] → [0,1]
    const normalizedRating = (rating - 1) / 4;

    // Fetch current relevance scores for the given chunk IDs
    const chunks = await backend.getChunksForFeedback(params.chunk_ids);

    if (chunks.length === 0) {
      return {
        content: [{ type: "text", text: "memory_feedback: no matching chunks found" }],
        isError: true,
      };
    }

    let updatedChunks = 0;
    const combinedText: string[] = [];

    // Apply EMA update to each chunk's relevance_score
    for (const chunk of chunks) {
      const oldScore = chunk.relevanceScore ?? 0.5;
      const newScore = oldScore + FEEDBACK_ALPHA * (normalizedRating - oldScore);
      await backend.updateChunkRelevanceScore(chunk.id, newScore);
      updatedChunks++;
      combinedText.push(chunk.text);
    }

    // Find entity mentions in updated chunks and apply EMA to kg_entities.feedback_weight
    const tenantId = params.tenant_id ?? "default";
    const entities = await backend.listKgEntities(tenantId, undefined, 500);
    const text = combinedText.join("\n").toLowerCase();

    let updatedEntities = 0;
    for (const entity of entities) {
      if (text.includes(entity.name.toLowerCase())) {
        await backend.updateEntityFeedbackWeight(entity.entity_id, normalizedRating, FEEDBACK_ALPHA);
        updatedEntities++;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            updated_chunks: updatedChunks,
            updated_entities: updatedEntities,
            rating,
            normalized_rating: normalizedRating,
          }),
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `memory_feedback error: ${String(e)}` }],
      isError: true,
    };
  }
}
