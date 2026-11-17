/**
 * Shared full-text tokenisation for the code graph.
 *
 * Identifier-like text (function names, qualified names, signatures) does not
 * split on whitespace the way prose does: `otherUrgent`, `other_urgent` and
 * `OtherUrgent` must all be findable by the word "urgent". Both backends store
 * this expanded text into their full-text index (Postgres to_tsvector('simple')
 * over it, SQLite FTS5 over it), so the sub-word form is computed once at
 * write time and both engines then see plain lowercase words.
 */

/** Split an identifier into its lower-case sub-words.
 *  camelCase → camel case, snake_case → snake case, ABBREViation → abbrev iation,
 *  qualified.name / path/to/File → all parts too. */
export function splitIdentifierWords(text: string): string[] {
  const words: string[] = [];
  for (const part of text.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    // "HTTPServer" → HTTP Server; "otherUrgent" → other Urgent; "v2_api" handled by the split above.
    for (const w of part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ")) {
      const lower = w.toLowerCase();
      if (lower.length >= 2) words.push(lower);
    }
  }
  return words;
}

/** The FTS document for a symbol: name + qualified name + signature, with every
 *  identifier additionally spelled out as sub-words so camel/snake matching works. */
export function symbolFtsText(name: string, qualifiedName: string, signature: string): string {
  const raw = `${name} ${qualifiedName} ${signature}`;
  const words = splitIdentifierWords(raw);
  return [...new Set([...raw.toLowerCase().split(/\s+/).filter(Boolean), ...words])].join(" ");
}
