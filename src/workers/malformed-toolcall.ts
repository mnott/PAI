/**
 * An unparsed tool-call block in assistant text: the local model server failed
 * to turn `<tool_call>…<parameter=…>` into a tool_use, so the text reached the
 * client as the answer. That is an instrument defect, never a model failure.
 */

const DAMAGED = /<tool_call>[\s\S]{0,200}?(?:<parameter=|<\/function>)/;

export function hasMalformedToolCall(text: string | null | undefined): boolean {
  return !!text && DAMAGED.test(text);
}

export const MALFORMED_TOOL_CALL = "malformed-tool-call";

/** The retry nudge the router appends as one extra user message. */
export const MALFORMED_RETRY_TEXT =
  "Your previous message contained a tool call in a damaged format and was not executed. Re-emit exactly that tool call in the correct format.";
