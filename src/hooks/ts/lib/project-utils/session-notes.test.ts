import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renameSessionNote, finalizeSessionNote } from "./session-notes.js";

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

describe("finalizeSessionNote", () => {
  it("inserts a summary containing $& literally", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    const note = join(dir, "0001 - 2026-10-18 - New Session.md");
    writeFileSync(note, "# Session 0001: x\n\n**Status:** In Progress\n\n---\n\n## Work Done\n\n---\n\n## Next Steps\n\n<!-- x -->\n");
    const out = finalizeSessionNote(note, "cost $& and $' and $`");
    const body = readFileSync(out, "utf-8");
    expect(body).toContain("## Next Steps\n\ncost $& and $' and $`");
    expect(body.match(/## Next Steps/g)).toHaveLength(1);
  });
});

describe("renameSessionNote collisions", () => {
  it("does not overwrite an existing note with the target name", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    const existing = join(dir, "0005 - 2026-10-18 - Same Title.md");
    const old = join(dir, "0005 - 2026-10-18 - New Session.md");
    writeFileSync(existing, "keep");
    writeFileSync(old, "new");
    const out = renameSessionNote(old, "same title");
    expect(readFileSync(existing, "utf-8")).toBe("keep");
    expect(out).not.toBe(existing);
    expect(readFileSync(out, "utf-8")).toBe("new");
  });
});
