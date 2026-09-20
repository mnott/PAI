import { describe, it, expect } from "vitest";
import { stripFrontmatter } from "./frontmatter.js";

describe("stripFrontmatter", () => {
  it("strips a leading YAML frontmatter block and trims surrounding blank lines", () => {
    const md = `---\nname: CORE\ndescription: some skill\n---\n\nBody text here.\n`;
    expect(stripFrontmatter(md)).toBe("Body text here.");
  });

  it("leaves content unchanged when there is no frontmatter", () => {
    const md = `Body text here.\nMore text.\n`;
    expect(stripFrontmatter(md)).toBe("Body text here.\nMore text.");
  });

  it("leaves a --- that appears inside the body (not at the top) alone", () => {
    const md = `---\nname: CORE\n---\n\nSection one.\n\n---\n\nSection two.\n`;
    expect(stripFrontmatter(md)).toBe("Section one.\n\n---\n\nSection two.");
  });
});
