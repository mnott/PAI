/**
 * cap.ts — bound the text a pattern is run against, so padding cannot stall a hook.
 */

const MAX_TOTAL = 64 * 1024;
const MAX_SEGMENT = 4 * 1024;

/**
 * Bound what a rule can be made to chew on. Over 64 KB keeps the first and
 * last 32 KB; each `;` `&` `||` newline segment over 4 KB keeps its first and
 * last 2 KB (the tail is where a `| sh` hides behind padding). Backslash-newline
 * continuations are joined so a command split over two lines reads as one.
 */
export function capContent(content: string): string {
  let text = content.length > MAX_TOTAL ? `${content.slice(0, MAX_TOTAL / 2)}\n${content.slice(-MAX_TOTAL / 2)}` : content;
  text = text.replace(/\\\r?\n/g, " ");
  if (text.length <= MAX_SEGMENT) return text;
  return text
    .split(/(;|&|\n|\|\|)/)
    .map((part, i) => (i % 2 === 0 && part.length > MAX_SEGMENT ? part.slice(0, MAX_SEGMENT / 2) + part.slice(-MAX_SEGMENT / 2) : part))
    .join("");
}
