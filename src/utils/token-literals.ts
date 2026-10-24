/**
 * token-literals.ts — the one scanner for raw token-shaped literals. Used by
 * the no-token-literals repo guard test and by the worker write-time hook, so
 * both flag exactly the same strings. Each pattern is assembled from parts so
 * this file itself carries no token-shaped literal.
 */

const join = (...parts: string[]): string => parts.join("");

export const TOKEN_PATTERNS: Array<[string, RegExp]> = [
  ["slack", new RegExp(join("xo", "[bap]-"))],
  ["anthropic", new RegExp(join("sk", "-ant-"))],
  ["github", new RegExp(join("gh", "p_", "[A-Za-z0-9]{20}"))],
  ["github-pat", new RegExp(join("github", "_pat_"))],
  ["gitlab", new RegExp(join("gl", "pat-"))],
  ["aws", new RegExp(join("AK", "IA[A-Z0-9]{16}"))],
  ["google", new RegExp(join("AI", "za[A-Za-z0-9_-]{30}"))],
  ["google-35", new RegExp(join("AI", "za[A-Za-z0-9_-]{35}"))],
  ["slack-any", new RegExp(join("xo", "x[abposr]-"))],
  // scheme://user:pass with a real (non-redacted) password
  ["url-creds", new RegExp(join("[a-z]+://", "[^\\s/:\"'`@\\[]+:", "[^\\s/@\"'`\\[]+@"))],
  ["pem", new RegExp(join("-----", "BEGIN ", "[A-Z ]*PRIVATE KEY"))],
];

/** Kinds of the patterns that match `line`, in pattern order. */
export function scanLine(line: string): string[] {
  return TOKEN_PATTERNS.filter(([, re]) => re.test(line)).map(([name]) => name);
}

/** Every (1-based line, kind) hit in `text`. */
export function scanText(text: string): Array<{ line: number; kind: string }> {
  const hits: Array<{ line: number; kind: string }> = [];
  text.split("\n").forEach((l, i) => {
    for (const kind of scanLine(l)) hits.push({ line: i + 1, kind });
  });
  return hits;
}
