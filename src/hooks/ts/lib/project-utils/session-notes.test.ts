import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renameSessionNote } from "./session-notes.js";

describe("renameSessionNote", () => {
  it("keeps a slash in the title from becoming a directory (ENOENT)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    const old = join(dir, "0062 - 2026-10-18 - New Session.md");
    writeFileSync(old, "x");
    const out = renameSessionNote(old, "Ab/llm Experiment And A/b Testing");
    expect(out).not.toBe(old);
    expect(existsSync(out)).toBe(true);
    expect(readdirSync(dir)).toEqual(["0062 - 2026-10-18 - Ab Llm Experiment And A B Testing.md"]);
  });
});
