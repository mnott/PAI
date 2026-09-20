/**
 * handover-budget.ts — cap the `## Continue` handover body injected at
 * SessionStart.
 *
 * Text tokenises at ~2.6 chars per token; a 1,600-char budget is ~620 tokens.
 * Together with the hook's 117-token fixed part, this stays under the 1,000-token
 * SessionStart limit, eliding retrospective `d=` (done) and `t=` (tests) fields
 * while preserving `g=` (goal), `@n` file pointers, and `z=` (state).
 */

export const HANDOVER_CHAR_BUDGET = 1600;

export interface BudgetResult {
  body: string;
  elided: string[];
  truncated: boolean;
}

interface Field {
  key: string;
  lines: string[];
}

const FIELD_START = /^([a-zA-Z@][a-zA-Z0-9]*)=/;

function splitFields(body: string): { preamble: string[]; fields: Field[] } {
  const lines = body.split("\n");
  const preamble: string[] = [];
  const fields: Field[] = [];
  let current: Field | null = null;
  for (const line of lines) {
    const m = line.match(FIELD_START);
    if (m) {
      current = { key: m[1], lines: [line] };
      fields.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, fields };
}

function elisionLine(key: string, charCount: number, sourcePath: string): string {
  return `${key}= elided, ${charCount} chars; full text in ${sourcePath} (## Continue)`;
}

function render(preamble: string[], fields: Field[]): string {
  const parts = [...preamble];
  for (const f of fields) parts.push(...f.lines);
  return parts.join("\n");
}

/**
 * Elide the `d=` and `t=` fields (in that order, only while still over
 * budget) before falling back to a hard truncation — those two fields are
 * retrospective, everything else (`g=`, `@n` pointers, `z=`) is what a
 * resumer actually needs.
 */
export function applyHandoverBudget(
  body: string,
  sourcePath: string,
  budget: number = HANDOVER_CHAR_BUDGET
): BudgetResult {
  if (body.length <= budget) {
    return { body, elided: [], truncated: false };
  }

  const { preamble, fields } = splitFields(body);
  const elided: string[] = [];

  if (fields.length > 0) {
    for (const key of ["d", "t"]) {
      if (render(preamble, fields).length <= budget) break;
      const field = fields.find((f) => f.key === key);
      if (!field) continue;
      const charCount = field.lines.join("\n").length;
      field.lines = [elisionLine(key, charCount, sourcePath)];
      elided.push(key);
    }
  }

  const result = render(preamble, fields);
  if (fields.length === 0 || result.length > budget) {
    const source = fields.length === 0 ? body : result;
    const truncated =
      source.slice(0, budget) +
      `\n[handover truncated at ${budget} chars; full text in ${sourcePath} (## Continue)]`;
    return { body: truncated, elided, truncated: true };
  }

  return { body: result, elided, truncated: false };
}
