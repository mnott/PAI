/** Convert Claude content (string or content block array) to plain text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        const block = c as Record<string, unknown>;
        if (block?.text) return String(block.text);
        if (block?.content) return String(block.content);
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}
