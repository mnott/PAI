/**
 * redact.ts — value-level secret redaction shared by every writer.
 *
 * A rule keeps the label and replaces only the value with [REDACTED], so the
 * context (which key, which scheme, which flag) survives while the secret does
 * not. Rules run in order over the whole text; a PEM block consumes its line
 * range first so the generic rules cannot mangle the BEGIN/END markers.
 * A long opaque run is redacted only when its line also carries a secret-ish
 * key word — a bare git SHA or base64 blob on its own line stays as is.
 */

export interface RedactRule {
  id: string;
  re: RegExp;
  replace: string | ((m: string, ...g: string[]) => string);
}

export const REDACTED = "[REDACTED]";
/** Key words that make a key=value pair, an env name or a long run secret-ish. */
const KEY_WORDS = "password|passwd|secret|token|api[_-]?key|credential|auth(?:orization)?|bearer";
/** A quoted or bare value after `key =` / `key:`. */
const VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s'"]+)`;

export const REDACT_RULES: RedactRule[] = [
  {
    // `key=value`, `key: value`, `"key": "value"` — key carries a secret-ish word;
    // the word must be a whole key segment, so `monkeys=` stays untouched
    id: "key-value",
    // the word must be a whole key segment, so `Authorization: Bearer` keeps its scheme
    // the word must be a whole key segment, so `Authorization: Bearer` keeps its scheme
    re: new RegExp(String.raw`((?:[A-Za-z0-9]+[_-])?(?:${KEY_WORDS})(?![A-Za-z0-9])[A-Za-z0-9_-]*)(\s*[:=]\s*)(${VAL})`, "gi"),
    replace: (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  },
  {
    // `export FOO_TOKEN=...` / `FOO_KEY=...` — SCREAMING_SNAKE env style
    id: "env-style",
    re: new RegExp(String.raw`((?:export\s+)?[A-Z][A-Z0-9]*_(?:KEY|SECRET|TOKEN|PASS\w*|CRED\w*|AUTH\w*)\s*=\s*)(${VAL})`, "g"),
    replace: (_m, head: string) => `${head}${REDACTED}`,
  },
  {
    // `Authorization: Bearer xxx` / `Authorization: Basic xxx` — keep the scheme
    id: "authorization",
    re: /(Authorization\s*:\s*)(Bearer|Basic)\s+(\S+)/gi,
    replace: (_m, head: string, scheme: string) => `${head}${scheme} ${REDACTED}`,
  },
  {
    // long CLI flags only: `--password X`, `--token X`, `--api-key X`, `--secret X`, `--passwd X`
    id: "cli-flag",
    re: new RegExp(String.raw`(--(?:password|token|api-key|secret|passwd)(?:\s*=)\s*)(${VAL})`, "gi"),
    replace: (_m, head: string) => `${head}${REDACTED}`,
  },
  {
    // `scheme://user:pass@host` — redact the password, keep user and host
    id: "url-credentials",
    re: /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)([^\s/@]+)(@)/gi,
    replace: (_m, head: string, _pass: string, at: string) => `${head}${REDACTED}${at}`,
  },
  {
    // provider token prefixes: sk-ant-, sk-, ghp_/gho_/ghu_/ghs_/ghr_, github_pat_,
    // glpat-, xoxb-/xoxp-/xoxa-, AKIA/ASIA + 16 chars, AIza + 35 chars, JWT (eyJ… three segments)
    id: "token-prefix",
    re: /\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|xox[bap]-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    replace: REDACTED,
  },
  {
    // 40+ char opaque base64/hex run, only on a line that also has a secret-ish key word
    id: "long-run",
    re: /\b[A-Za-z0-9+/]{40,}={0,2}(?![\w/])/g,
    replace: REDACTED,
  },
];

/** PEM private-key block, complete or truncated at the end of the text. */
const PEM_BLOCK = /-----BEGIN[^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-\n]*PRIVATE KEY-----|$)/g;
/** Line-start rule: applied per line, never across lines. */
const LINE_RULES = REDACT_RULES.filter((r) => r.id !== "long-run");
const LONG_RUN = REDACT_RULES.find((r) => r.id === "long-run") as RedactRule;
const KEY_LINE = new RegExp(`(?:${KEY_WORDS})`, "i");

/** One line with every line rule applied, then the long-run rule when the line is key-ish. */
function redactLine(line: string): string {
  let out = line;
  for (const r of LINE_RULES) out = out.replace(r.re, r.replace as never);
  if (KEY_LINE.test(out)) out = out.replace(LONG_RUN.re, LONG_RUN.replace as never);
  return out;
}

/** Text with every secret value replaced by [REDACTED]; labels, schemes and hosts survive. */
export function redactSecrets(text: string): string {
  // PEM first: a block swallows its lines so line rules cannot touch the markers
  const withPem = text.replace(PEM_BLOCK, `-----BEGIN PRIVATE KEY----- ${REDACTED}`);
  return withPem.split("\n").map(redactLine).join("\n");
}
