/**
 * Text the code graph writes to storage: NUL- and lone-surrogate-safe.
 *
 * Postgres `text` cannot hold a U+0000 byte — inserting one (or feeding it to
 * `to_tsvector('simple', …)`, the generated tsvector over code_symbols.search_text)
 * fails with `invalid byte sequence for encoding "UTF8": 0x00`. That is exactly
 * what crashed `pai code explore` on a real index run: source files carry raw
 * NUL bytes (a deliberate separator in a template literal, e.g. the triple-dedupe
 * key in relate.ts), and tree-sitter copies those bytes straight into the symbol
 * signature / doc comment / search_text that reach Postgres. Lone surrogates fail
 * the same way on encode ("… surrogate pairs").
 *
 * Every string field of every row is passed through `sanitize` at the storage
 * boundary (both backends), so a stray control byte never reaches either engine.
 */

// Built without a literal NUL in this file's bytes: writing one would make this
// very source file look binary to the indexer and the write tools alike.
const NUL = String.fromCharCode(0);

/** Drop NUL bytes and unpaired (lone) surrogates from text destined for storage.
 *  Other control characters are left alone: Postgres accepts them in `text`. */
export function sanitize(s: string): string {
  // fast path: the overwhelmingly common case has neither a NUL nor a surrogate
  if (!s || (s.indexOf(NUL) < 0 && !/[\uD800-\uDFFF]/.test(s))) return s;
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // a lone surrogate is a single code unit in D800–DFFF that did not pair;
    // well-formed surrogate pairs arrive here as one astral code point (> FFFF).
    if (c === 0) continue;
    if (c >= 0xd800 && c <= 0xdfff) continue;
    out += ch;
  }
  return out;
}

/** True when the first `bytes` of a buffer look binary: it contains a NUL. */
export function looksBinary(buf: Buffer, bytes = 8192): boolean {
  return buf.subarray(0, bytes).includes(0);
}
