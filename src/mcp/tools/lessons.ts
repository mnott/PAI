/**
 * MCP tool handler: memory_lessons
 *
 * Read-only access to the review-gated lessons; approved ones by default.
 */

import { LESSON_STATES, getLesson, listLessons, type LessonState } from "../../memory/lessons.js";
import type { ToolResult } from "./types.js";

export interface MemoryLessonsParams {
  action: "list" | "get";
  state?: LessonState;
  project?: string;
  id?: string;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export async function toolMemoryLessons(params: MemoryLessonsParams): Promise<ToolResult> {
  try {
    if (params.action === "get") {
      if (!params.id) return text("id is required for action=get", true);
      const l = getLesson(params.id);
      if (l && l.state !== (params.state ?? "approved")) return text(`Lesson not found: ${params.id} (state ${l.state}; pass state=${l.state} to read it)`, true);
      return l ? text(JSON.stringify(l, null, 2)) : text(`Lesson not found: ${params.id}`, true);
    }
    const state = params.state ?? "approved";
    if (!LESSON_STATES.includes(state)) return text(`Unknown state: ${state}`, true);
    const ls = listLessons({ state, project: params.project });
    return text(ls.length ? JSON.stringify(ls, null, 2) : `No ${state} lessons.`);
  } catch (e) {
    return text(`memory_lessons error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
