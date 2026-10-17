import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { smartDecodeDir, type DirListings } from "./utils.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pai-decode-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "09 - Job.Search", "sub-dir"), { recursive: true });
const enc = (p: string) => p.replace(/[/.\s-]/g, "-");

describe("smartDecodeDir listings", () => {
  const target = join(root, "09 - Job.Search", "sub-dir");

  it("decodes the same with and without a shared listings map", () => {
    expect(smartDecodeDir(enc(target))).toBe(target);
    const listings: DirListings = new Map();
    expect(smartDecodeDir(enc(target), listings)).toBe(target);
    expect(listings.has(root)).toBe(true);
  });

  it("reuses a listing instead of re-reading the directory", () => {
    const listings: DirListings = new Map();
    smartDecodeDir(enc(target), listings);
    mkdirSync(join(root, "late"));
    expect(smartDecodeDir(enc(join(root, "late")), listings)).toBeNull(); // served from the memo
    expect(smartDecodeDir(enc(join(root, "late")))).toBe(join(root, "late")); // fresh read sees it
  });
});
