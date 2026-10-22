import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { isDistStale } from "./dist-stale.mjs";

describe("isDistStale", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dist-stale-"));
    mkdirSync(join(dir, "src", "commands"), { recursive: true });
    writeFileSync(join(dir, "src", "commands", "a.ts"), "");
    writeFileSync(join(dir, "entry.mjs"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const touch = (p: string, s: number) => utimesSync(p, s, s);

  it("is stale when a nested source file is newer than the entry", () => {
    touch(join(dir, "entry.mjs"), 1000);
    touch(join(dir, "src", "commands", "a.ts"), 2000);
    expect(isDistStale(join(dir, "src"), join(dir, "entry.mjs"))).toBe(true);
  });

  it("is fresh when the entry is newer than all sources", () => {
    touch(join(dir, "src", "commands", "a.ts"), 1000);
    touch(join(dir, "entry.mjs"), 2000);
    expect(isDistStale(join(dir, "src"), join(dir, "entry.mjs"))).toBe(false);
  });
});
