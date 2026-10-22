/**
 * no-token-literals.test.ts — repo guard: no *.test.ts file may contain a raw
 * token-shaped literal (GitHub push protection flags fake fixtures). Tests
 * must assemble such strings at runtime via src/utils/fake-secret.ts.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Same regex set as the rg proof command; each alternative is split across
// parts so this file itself carries no token-shaped literal.
const PATTERNS: Array<[string, RegExp]> = [
  ["slack", new RegExp(fake("xo", "[bap]-"))],
  ["anthropic", new RegExp(fake("sk", "-ant-"))],
  ["github", new RegExp(fake("gh", "p_", "[A-Za-z0-9]{20}"))],
  ["github-pat", new RegExp(fake("github", "_pat_"))],
  ["gitlab", new RegExp(fake("gl", "pat-"))],
  ["aws", new RegExp(fake("AK", "IA[A-Z0-9]{16}"))],
  ["google", new RegExp(fake("AI", "za[A-Za-z0-9_-]{30}"))],
  ["pem", new RegExp(fake("-----", "BEGIN ", "[A-Z ]*PRIVATE KEY"))],
];

/** Concatenates parts so the guard file stays free of token-shaped literals. */
function fake(...parts: string[]): string {
  return parts.join("");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("no raw token-shaped literals in test files", () => {
  it("every *.test.ts under src is free of scanner-flagged literals", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const [name, re] of PATTERNS) {
          if (re.test(line)) offenders.push(`${file}:${i + 1} (${name})`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
