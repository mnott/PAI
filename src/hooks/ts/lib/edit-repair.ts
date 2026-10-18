/**
 * edit-repair.ts — deterministic repair of Edit/MultiEdit old_string values
 * whose whitespace the model altered (newlines collapsed to spaces, indentation
 * changed). The decision: old_string is absent verbatim, but its
 * whitespace-normalised form occurs exactly once in the whitespace-normalised
 * file; the edit then targets the exact original span. Zero or several
 * matches pass untouched so the normal error and edit-assist hint follow.
 * A no-op edit (old_string === new_string) is denied up front.
 *
 * Pure apart from the injected `readFile`, same split as path-repair.ts.
 */

import { readFileSync } from "node:fs";
import { editAssist } from "../../../workers/edit-assist.js";
import { renderDeny } from "./path-repair.js";

export interface EditRepairInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface EditRepair {
  updatedInput: Record<string, unknown>;
  count: number;
}

export interface EditRepairResult {
  repair?: EditRepair;
  deny?: string;
}

export const REPAIR_NOTE = "edit repaired: whitespace-normalised match";

const NOOP_ERROR = "No changes to make: old_string and new_string are exactly the same";

/** Collapse whitespace runs to one space; map[i] is the original offset of normalised char i. */
function normalise(text: string): { norm: string; map: number[]; end: number[] } {
  let norm = "";
  const map: number[] = [];
  const end: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (norm.length > 0) {
        norm += " ";
        map.push(i);
        end.push(j);
      }
      i = j;
    } else {
      norm += text[i];
      map.push(i);
      end.push(i + 1);
      i++;
    }
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
    end.pop();
  }
  return { norm, map, end };
}

/** The exact original span matching `old` modulo whitespace, or null unless it is unique. */
export function findNormalisedSpan(file: string, old: string): string | null {
  const needle = old.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const { norm, map, end } = normalise(file);
  const at = norm.indexOf(needle);
  if (at < 0 || norm.indexOf(needle, at + 1) >= 0) return null;
  return file.slice(map[at], end[at + needle.length - 1]);
}

export function repairEdit(
  input: EditRepairInput,
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => string | null = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
): EditRepairResult | null {
  if (env.PAI_WORKER !== "1") return null;
  const ti = input.tool_input;
  if (!ti || typeof ti.file_path !== "string") return null;

  const isMulti = input.tool_name === "MultiEdit";
  if (input.tool_name !== "Edit" && !isMulti) return null;
  const edits: Array<Record<string, unknown>> = isMulti ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];

  for (const e of edits) {
    if (typeof e?.old_string === "string" && e.old_string === e.new_string) {
      const hint = editAssist({ oldString: e.old_string, newString: String(e.new_string), errorText: NOOP_ERROR, fileText: null });
      return { deny: hint ?? NOOP_ERROR };
    }
  }

  const file = readFile(ti.file_path);
  if (file === null) return null;

  let count = 0;
  // MultiEdit applies edits in order, so later edits see earlier new_strings.
  let current = file;
  const fixed = edits.map((e) => {
    const old = e?.old_string;
    if (typeof old !== "string" || old === "") return e;
    let next = old;
    if (!current.includes(old)) {
      const span = findNormalisedSpan(current, old);
      if (span === null) return e;
      next = span;
      count++;
    }
    if (typeof e.new_string === "string") current = current.replace(next, () => e.new_string as string);
    return next === old ? e : { ...e, old_string: next };
  });
  if (count === 0) return null;
  return { repair: { updatedInput: isMulti ? { ...ti, edits: fixed } : (fixed[0] as Record<string, unknown>), count } };
}

export function renderEditRepair(r: EditRepair): string {
  return JSON.stringify({
    systemMessage: REPAIR_NOTE,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: r.updatedInput,
    },
  });
}

export { renderDeny };
