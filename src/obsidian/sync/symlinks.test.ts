import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanBrokenSymlinks } from "./symlinks.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "sl-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cleanBrokenSymlinks", () => {
  it("keeps a valid relative link and removes a broken one", () => {
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "d", "real.md"), "x");
    symlinkSync("real.md", join(dir, "d", "good"));
    symlinkSync("missing.md", join(dir, "d", "bad"));
    expect(cleanBrokenSymlinks(join(dir, "d"))).toBe(1);
    expect(existsSync(join(dir, "d", "good"))).toBe(true);
    expect(() => lstatSync(join(dir, "d", "bad"))).toThrow();
  });
});
