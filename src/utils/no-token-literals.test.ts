/**
 * no-token-literals.test.ts — repo guard: no *.test.ts file may contain a raw
 * token-shaped literal (GitHub push protection flags fake fixtures). Tests
 * must assemble such strings at runtime via src/utils/fake-secret.ts.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanLine } from "./token-literals.js";

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
        for (const name of scanLine(line)) offenders.push(`${file}:${i + 1} (${name})`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
