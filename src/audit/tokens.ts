/**
 * tokens.ts — the one tokenizer every audit section counts through.
 *
 * cl100k_base via js-tiktoken (pure JS, no native build). "all" + [] for the
 * allowed/disallowed-special-token arguments matches Python tiktoken's
 * `disallowed_special=()`: audited text (hook stdout, session transcripts)
 * routinely contains literal "<|...|>"-shaped substrings that are not actual
 * special tokens, and the strict default throws on sight of them.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";

export const TOKEN_ENCODING = "cl100k_base";

let cached: Tiktoken | null = null;

function encoder(): Tiktoken {
  if (!cached) cached = getEncoding(TOKEN_ENCODING);
  return cached;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return encoder().encode(text, "all", []).length;
}
