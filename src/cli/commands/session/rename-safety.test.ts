import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sanitizeTitle, checkedRenameTarget } from "./commands.js";
import { toTitleCase, formatFilename } from "./helpers.js";

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function notes(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-rename-"));
  tmps.push(d);
  return d;
}

describe("session rename safety", () => {
  it("strips separators and .. from the title", () => {
    expect(sanitizeTitle("a/../../X")).toBe("a X");
    expect(sanitizeTitle("..\\evil")).toBe("evil");
  });

  it("a hostile title stays inside the notes dir", () => {
    const d = notes();
    const name = formatFilename(1, "2026-01-01", toTitleCase(sanitizeTitle("a/../../X")));
    const p = checkedRenameTarget(d, join(d, "old.md"), name);
    expect(p.startsWith(d)).toBe(true);
  });

  it("rejects an unsanitised escaping filename", () => {
    const d = notes();
    expect(() => checkedRenameTarget(d, join(d, "old.md"), "x/../../X.md")).toThrow(/escapes/);
  });

  it("refuses to overwrite an existing note", () => {
    const d = notes();
    writeFileSync(join(d, "taken.md"), "x");
    expect(() => checkedRenameTarget(d, join(d, "old.md"), "taken.md")).toThrow(/overwrite/);
  });
});
