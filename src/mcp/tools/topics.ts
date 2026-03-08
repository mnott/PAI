/**
 * MCP tool handler: topic_detect
 */

import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tool: topic_detect
// ---------------------------------------------------------------------------

export interface TopicDetectParams {
  /** Recent conversation context (a few sentences summarising recent activity) */
  context: string;
  /** The project slug the session is currently routed to. */
  current_project?: string;
  /**
   * Minimum confidence [0,1] to declare a shift. Default: 0.6.
   * Higher = less sensitive (fewer false positives).
   */
  threshold?: number;
}

/**
 * Detect whether recent conversation context has shifted to a different project.
 * Uses memory_search to find which project best matches the context, then
 * compares against the current project.
 *
 * Calls the daemon via IPC so it has access to the storage backend.
 * Falls back gracefully if the daemon is not running.
 */
export async function toolTopicDetect(
  params: TopicDetectParams
): Promise<ToolResult> {
  try {
    const { PaiClient } = await import("../../daemon/ipc-client.js");
    const client = new PaiClient();

    const result = await client.topicCheck({
      context: params.context,
      currentProject: params.current_project,
      threshold: params.threshold,
    });

    const lines: string[] = [
      `shifted: ${result.shifted}`,
      `current_project: ${result.currentProject ?? "(none)"}`,
      `suggested_project: ${result.suggestedProject ?? "(none)"}`,
      `confidence: ${result.confidence.toFixed(3)}`,
      `chunks_scored: ${result.chunkCount}`,
    ];

    if (result.topProjects.length > 0) {
      lines.push("");
      lines.push("top_matches:");
      for (const p of result.topProjects) {
        lines.push(`  ${p.slug}: ${(p.score * 100).toFixed(1)}%`);
      }
    }

    if (result.shifted) {
      lines.push("");
      lines.push(
        `TOPIC SHIFT DETECTED: conversation appears to be about "${result.suggestedProject}" ` +
        `(confidence: ${(result.confidence * 100).toFixed(0)}%), not "${result.currentProject}".`
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `topic_detect error: ${String(e)}` }],
      isError: true,
    };
  }
}
