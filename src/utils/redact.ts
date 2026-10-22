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
const REDACTED_RE = String.raw`\[REDACTED\]`;
/** Key words that make a key=value pair, an env name or a long run secret-ish. */
const KEY_WORDS = "password|passwd|secret|token|api[_-]?key|credential|auth(?:orization)?|bearer";
/** Lowercase prose words that follow a key in a sentence (`the secret: is out`) — never a value. */
const PROSE = "is|are|was|were|be|to|of|in|on|for|and|or|the|a|an|that|this|it|not|out|here|there|so|as|at|by|with|if|when|which";
/** A quoted or bare value after `key =` / `key:`. */
const VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s'"]+)`;
/** Substrings that pre-filter key names for the key-value rule. */
const KEY_SUBSTR = "pass|pwd|secret|token|key|credential|auth|bearer|sig";
/** Key segments (lowercase) that mark a key as secret-ish. */
const SECRET_SEGMENTS = new Set(["password", "passwd", "pwd", "pass", "secret", "token", "key", "apikey", "accountkey", "credential", "credentials", "auth", "authorization", "bearer", "signature", "sig"]);
/** Values that are types, identifiers or references rather than secrets. */
const TYPE_VALUE = /^(?:string|number|boolean|any|unknown|null|undefined|void|never|object|required|optional|true|false|none)$/i;
/** Known non-secret words that may follow `key:` in prose or schema docs — a closed list, so a passphrase (`password: correcthorsebattery`) is redacted. */
const NON_SECRET_WORDS = new Set(["is", "are", "was", "be", "required", "optional", "none", "null", "nil", "undefined", "true", "false", "yes", "no", "string", "number", "boolean", "any", "object", "unknown", "void", "empty", "missing", "set", "unset", "see", "below", "above", "here", "there", "enabled", "disabled", "todo", "tbd", "n/a"]);

/** True when any `_`/`-`/camelCase segment of the key is a secret word. */
function isSecretKey(key: string): boolean {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  return spaced.split(/[_-]+/).some((seg) => SECRET_SEGMENTS.has(seg.toLowerCase()));
}

/** Unquoted value that is code or prose: type keyword, call, env reference, or (after `:`) a known non-secret word. */
function isNotSecretValue(val: string, sep: string): boolean {
  const v = val.replace(/[;,)]+$/, "");
  return TYPE_VALUE.test(v)
    || /^[A-Za-z_$][\w$.]*\(/.test(v)
    || /^(?:process\.env|import\.meta\.env)\.\w+$/.test(v)
    || (sep.trim() === ":" && NON_SECRET_WORDS.has(v.toLowerCase()));
}

/** A long run that is a file path: `.ext` follows it, or it has 3+ alphanumeric `/` segments. */
function looksLikePath(run: string, after: string): boolean {
  if (run.includes("/") && /[A-Za-z]/.test(run) && /^\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/.test(after)) return true;
  const segs = run.replace(/^\/+/, "").split("/");
  return segs.length >= 4 && segs.every((x) => /^[A-Za-z0-9+]+$/.test(x));
}

export const REDACT_RULES: RedactRule[] = [
  {
    // `Authorization: Bearer xxx` / `Authorization: Basic xxx` — keep the scheme
    id: "authorization",
    re: /(Authorization\s*:\s*)(Bearer|Basic)\s+([^\s'"]+)/gi,
    replace: (_m, head: string, scheme: string) => `${head}${scheme} ${REDACTED}`,
  },
  {
    // `Cookie: a=b; c=d` — keep the cookie names, redact every value
    id: "cookie",
    re: /((?:Set-)?Cookie\s*:\s*)([^\n]+)/gi,
    replace: (_m, head: string, rest: string) => `${head}${rest.replace(/([^=;\s'"]+=)[^;'"]*/g, `$1${REDACTED}`)}`,
  },
  {
    // `key=value`, `key: value`, `"key": "value"` — a key segment (split on `_`, `-` and
    // camelCase) is a secret-ish word, so `monkeys=` stays untouched. The separator may
    // start with the key's closing quote (JSON); it is kept. The regex only pre-filters
    // by substring; `isSecretKey` and `isNotSecretValue` decide.
    id: "key-value",
    re: new RegExp(String.raw`(?<![A-Za-z0-9_-])((?=[A-Za-z0-9_-]*(?:${KEY_SUBSTR}))[A-Za-z0-9_-]+)(["']?\s*[:=]\s*)(?!(?:Bearer|Basic) ${REDACTED_RE})(?!(?:${PROSE})\b)((?:Bearer|Basic)[ \t]+[^\s'"]+|${VAL})`, "gi"),
    replace: (m, key: string, sep: string, val: string) => {
      if (!isSecretKey(key)) return m;
      // `token_count: 5` — a size/limit of a secret is not a secret
      if (/[_-](?:count|length|len|size|limit|max|min|budget)$/i.test(key) && /^\d+$/.test(val)) return m;
      const quoted = /^["']/.test(val);
      if (!quoted && isNotSecretValue(val, sep)) return m;
      const q = sep[0] === '"' || sep[0] === "'" ? val[0] : "";
      return q && (q === '"' || q === "'") ? `${key}${sep}${q}${REDACTED}${q}` : `${key}${sep}${REDACTED}`;
    },
  },
  {
    // npmrc `//registry/:_authToken=xxx`
    id: "npm-auth-token",
    re: new RegExp(String.raw`(_authToken\s*=\s*)(${VAL})`, "g"),
    replace: (_m, head: string) => `${head}${REDACTED}`,
  },
  {
    // `curl -u user:pass` / `--user user:pass` — keep the user
    id: "curl-user",
    re: /(\bcurl\b(?:(?!\bcurl\b)[^\n]){0,500}?\s(?:-u\s*|--user[\s=]+)['"]?[^\s:'"]+:)([^\s'"]+)/g,
    replace: (_m, head: string) => `${head}${REDACTED}`,
  },
  {
    // `mysql -phunter2` / `mysqldump -p'hunter2'` — attached password only
    id: "mysql-p",
    re: /(\bmysql(?:dump)?\b(?:(?!\bmysql)[^\n]){0,300}?\s-p)('[^']*'|"[^"]*"|[^\s'"-][^\s'"]*)/g,
    replace: (_m, head: string) => `${head}${REDACTED}`,
  },
  {
    // `mysql -u root -p hunter2` — space form; a plain lowercase word is the database name
    id: "mysql-p-space",
    re: /(\bmysql(?:dump)?\b(?:(?!\bmysql)[^\n]){0,300}?\s-p\s+)('[^']*'|"[^"]*"|[^\s'"-][^\s'"]*)/g,
    replace: (m, head: string, val: string) => (/^[a-z]+$/.test(val) ? m : `${head}${REDACTED}`),
  },
  {
    // `export FOO_TOKEN=...` / `FOO_KEY=...` — SCREAMING_SNAKE env style
    id: "env-style",
    re: new RegExp(String.raw`(?<![A-Za-z0-9])((?:export\s+)?[A-Z][A-Z0-9]*_(?:KEY|SECRET|TOKEN|PASS\w*|CRED\w*|AUTH\w*)\s*=\s*)(${VAL})`, "g"),
    replace: (_m, head: string) => `${head}${REDACTED}`,
  },
  {
    // long CLI flags ending in a secret word: `--password X`, `--client-secret X`, `--api-key=X`
    id: "cli-flag",
    re: new RegExp(String.raw`(--(?:\w+-)*(?:password|passwd|pwd|token|apikey|secret|key)(?:\s*=\s*|\s+(?!-)))(${VAL})`, "gi"),
    replace: (_m, head: string) => `${head}${REDACTED}`,
  },
  {
    // `scheme://user:pass@host` — redact the password, keep user and host
    id: "url-credentials",
    re: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)([^\s/@]+)(@)/gi,
    replace: (_m, head: string, _pass: string, at: string) => `${head}${REDACTED}${at}`,
  },
  {
    // provider token prefixes: sk-ant-, sk-, ghp_/gho_/ghu_/ghs_/ghr_, github_pat_,
    // glpat-, xoxb-/xoxp-/xoxa-/xoxs-/xapp-, ya29., SendGrid SG.x.y, shpat_/shpss_, dop_v1_, pypi-, AKIA/ASIA + 16 chars, AIza + 35 chars, JWT (eyJ… three segments)
    id: "token-prefix",
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[bapsr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9_-]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}|shp(?:at|ss|ca|pa)_[A-Za-z0-9]{20,}|dop_v1_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g,
    replace: REDACTED,
  },
  {
    // bare `Bearer <opaque>` outside a header — needs a digit or mixed case so prose stays
    id: "bearer",
    re: /\bBearer\s+(?!\[REDACTED\])(?=[\w.~+/=-]*(?:\d|[a-z][A-Z]))[\w.~+/=-]{8,}/g,
    replace: `Bearer ${REDACTED}`,
  },
  {
    // 40+ char opaque base64/hex run, only on a line that also has a secret-ish key word
    id: "long-run",
    re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,4096}={0,2}(?![\w/])/g,
    // a bare 40-hex git SHA / 64-hex sha256 stays and so does a file path; they are only
    // redacted as the value of a secret key
    replace: (m, ...g) => {
      const str = g[g.length - 1] as unknown as string;
      const off = g[g.length - 2] as unknown as number;
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(m) || looksLikePath(m, str.slice(off + m.length)) ? m : REDACTED;
    },
  },
];

/** PEM private-key block, complete or truncated at the end of the text. */
const PEM_BLOCK = /-----BEGIN[^-\n]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[^-\n]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** Line-start rule: applied per line, never across lines. */
const LINE_RULES = REDACT_RULES.filter((r) => r.id !== "long-run");
const LONG_RUN = REDACT_RULES.find((r) => r.id === "long-run") as RedactRule;
/** Lines longer than this skip the long-run rule. */
const LONG_RUN_MAX_LINE = 64 * 1024;
const KEY_LINE = new RegExp(`(?:${KEY_WORDS})`, "i");

/** Substring a line must contain for a (case-sensitive) rule to possibly match; a cheap skip for short lines. */
const NEEDS: Record<string, string> = {
  "npm-auth-token": "_authToken",
  "curl-user": "curl",
  "mysql-p": "mysql",
  "mysql-p-space": "mysql",
  "cli-flag": "--",
  "url-credentials": "://",
  bearer: "Bearer",
};

/** One line with every line rule applied, then the long-run rule when the line is key-ish. */
function redactLine(line: string): string {
  let out = line;
  for (const r of LINE_RULES) {
    const need = NEEDS[r.id];
    if (need && !out.includes(need)) continue;
    out = out.replace(r.re, r.replace as never);
  }
  if (out.length <= LONG_RUN_MAX_LINE && KEY_LINE.test(out)) out = out.replace(LONG_RUN.re, LONG_RUN.replace as never);
  return out;
}

/** Text with every secret value replaced by [REDACTED]; labels, schemes and hosts survive. */
export function redactSecrets(text: string): string {
  // PEM first: a block swallows its lines so line rules cannot touch the markers
  const withPem = text.replace(PEM_BLOCK, `-----BEGIN PRIVATE KEY----- ${REDACTED}`);
  return withPem.split("\n").map(redactLine).join("\n");
}
