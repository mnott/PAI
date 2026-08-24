/**
 * A cleanup run must not renumber existing notes.
 *
 * The scanner used to reassign every surviving note to its position in the
 * sorted list (`newNum = idx + 1`). That makes the number a position, while
 * the rest of the system uses it as an identity — handovers and notes cite
 * each other by number — and the two part company the moment the set changes.
 *
 * Measured cost on a real corpus: because the number is also written into the
 * H1 (`# Session 0006: ...`), a shift rewrote file contents as well as names,
 * so git could not pair the results as renames. One shift produced 261
 * deletions and 262 additions; the operator changed a single source file and
 * their prompt reported 262 changes. Real uncommitted work becomes invisible
 * in that noise.
 *
 * This is pinned two ways, because the behaviour came back once already after
 * the documentation forbade it: the map must be empty for any input, and the
 * position-indexing expression must not reappear in the source.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scannerSource = readFileSync(join(here, "scanner.ts"), "utf-8");

describe("the cleanup scanner never renumbers", () => {
  it("does not assign numbers from list position", () => {
    // The exact shape of the removed defect. Comments mentioning it are fine;
    // an assignment is not, so this looks for the assignment specifically.
    const positionAssignment = /const\s+newNum\s*=\s*idx\s*\+\s*1/;
    expect(scannerSource).not.toMatch(positionAssignment);
  });

  it("builds an empty renumber map whatever the input", () => {
    // buildRenumberMap is module-private by design, so drive it through the
    // one property that matters and is observable: the source states the
    // guarantee and returns an empty Map unconditionally.
    const builder = scannerSource.slice(
      scannerSource.indexOf("function buildRenumberMap"),
      scannerSource.indexOf("export function analyzeProject"),
    );
    expect(builder).toContain("return new Map()");
    // No loop may populate it.
    expect(builder).not.toMatch(/map\.set\(/);
  });
});
