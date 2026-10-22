import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshClaudeMd } from "./claude-md-refresh.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-claudemd-"));
  file = join(dir, "CLAUDE.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("refreshClaudeMd", () => {
  it("edited file: original untouched, new version beside it as .pai-new", () => {
    writeFileSync(file, "old template\nmy own rule\n");
    const r = refreshClaudeMd(file, "new template\n", "old template\n");
    expect(r).toEqual({ action: "wrote-beside", newPath: `${file}.pai-new` });
    expect(readFileSync(file, "utf8")).toBe("old template\nmy own rule\n");
    expect(readFileSync(`${file}.pai-new`, "utf8")).toBe("new template\n");
  });

  it("unknown previous rendering counts as edited", () => {
    writeFileSync(file, "whatever\n");
    expect(refreshClaudeMd(file, "new\n", null).action).toBe("wrote-beside");
    expect(readFileSync(file, "utf8")).toBe("whatever\n");
  });

  it("pristine file: timestamped backup, then replaced", () => {
    writeFileSync(file, "old template\n");
    const r = refreshClaudeMd(file, "new template\n", "old template", new Date("2026-10-22T10:00:00Z"));
    expect(r.action).toBe("replaced");
    expect(readFileSync(file, "utf8")).toBe("new template\n");
    const backup = (r as { backup: string }).backup;
    expect(backup).toBe(`${file}.bak-20261022T100000Z`);
    expect(readFileSync(backup, "utf8")).toBe("old template\n");
    expect(existsSync(`${file}.pai-new`)).toBe(false);
    expect(readdirSync(dir).some((f) => f.includes(".tmp-pai-"))).toBe(false);
  });

  it("already current: nothing written", () => {
    writeFileSync(file, "same\n");
    expect(refreshClaudeMd(file, "same\n", "other").action).toBe("unchanged");
    expect(readdirSync(dir)).toEqual(["CLAUDE.md"]);
  });
});
