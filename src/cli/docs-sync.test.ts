import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUPS } from "./registry.js";
import { renderPages } from "./docgen.js";

const DOCS = resolve(__dirname, "..", "..", "docs", "commands");

describe("docs/commands is in sync with the command definitions", () => {
  it("matches the generated pages byte-for-byte", () => {
    const pages = renderPages(GROUPS, join(DOCS, "_examples"));
    const expected = new Set(pages.map((p) => p.name));
    const stale = readdirSync(DOCS).filter((f) => f.endsWith(".md") && !expected.has(f));
    const drift = pages
      .filter((p) => !existsSync(join(DOCS, p.name)) || readFileSync(join(DOCS, p.name), "utf8") !== p.markdown)
      .map((p) => p.name);
    const files = [...drift, ...stale];
    expect(
      files,
      `docs/commands out of date (${files.join(", ")}). Run \`npm run build\` and commit the regenerated docs with your change.`,
    ).toEqual([]);
  });
});
