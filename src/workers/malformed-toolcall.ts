/**
 * An unparsed tool-call block in assistant text: the local model server failed
 * to turn `<tool_call>…<parameter=…>` into a tool_use, so the text reached the
 * client as the answer. That is an instrument defect, never a model failure.
 */

/**
 * The one detector, shared by the router retry (isDamaged) and the worker
 * classification (pool-host / finalise): an assistant turn that shows a tool
 * call the server never parsed into a tool_use. The tags must open a line —
 * only whitespace may precede them — so prose that merely mentions `tool_call`
 * mid-sentence stays a real answer. A bare `<tool_call>` is damage on its own,
 * whatever follows: local models truncate calls mid-stream, so no
 * `<parameter=` or `</function>` is required any more.
 */
const DAMAGED = /(?:(^\s*)<tool_call\b)|(?:(^\s*)<function=)|(?:(^\s*)<parameter=)/m;

export function hasMalformedToolCall(text: string | null | undefined): boolean {
  return !!text && DAMAGED.test(text);
}

export const MALFORMED_TOOL_CALL = "malformed-tool-call";

/** The retry nudge the router appends as one extra user message. */
export const MALFORMED_RETRY_TEXT =
  "Your previous message contained a tool call in a damaged format and was not executed. Re-emit exactly that tool call in the correct format.";

/**
 * A degenerate answer: the model ended its turn with a stray token ("," after
 * two generated tokens) on a task that needed work. Also an instrument fault.
 */
export const DEGENERATE_ANSWER = "degenerate-answer";

const MAX_DEGENERATE_CHARS = 3;
/** Below this the task may legitimately be answered in a word. */
const MIN_NONTRIVIAL_CHARS = 200;

/** True when `answer` is ≤ 3 characters, no tool ran, and the task text is non-trivial. */
export function isDegenerateAnswer(answer: string | null | undefined, tools: number, taskText: string): boolean {
  return tools === 0 && (answer ?? "").trim().length <= MAX_DEGENERATE_CHARS && taskText.trim().length >= MIN_NONTRIVIAL_CHARS;
}

export const DEGENERATE_RETRY_TEXT = "Your previous message was empty of content. Do the task above: use your tools and end with the final report.";
