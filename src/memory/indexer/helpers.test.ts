import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { isPathTooBroadForContentScan } from "./helpers.js";

// tmpdir() is under a blocked root, so use a folder one level below the real home (tests redirect HOME to a temp dir).
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(userInfo().homedir, ".pai-scan-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isPathTooBroadForContentScan", () => {
  it("scans a docs-only git repo", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "guide.md"), "# doc");
    expect(isPathTooBroadForContentScan(dir)).toBe(false);
  });
  it("skips a git repo with a code marker", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "package.json"), "{}");
    expect(isPathTooBroadForContentScan(dir)).toBe(true);
  });
  it("skips a git repo with an .xcodeproj", () => {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "App.xcodeproj"));
    expect(isPathTooBroadForContentScan(dir)).toBe(true);
  });
  it("scans a plain folder and still blocks system roots", () => {
    expect(isPathTooBroadForContentScan(dir)).toBe(false);
    expect(isPathTooBroadForContentScan("/tmp")).toBe(true);
    expect(isPathTooBroadForContentScan(homedir())).toBe(true);
  });
});
