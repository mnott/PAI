import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { saveQueryResult } from "./query-feedback.js";

let home: string;
const prev = process.env.PAI_HOME;
beforeEach(() => {
  home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "qf-"));
  process.env.PAI_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("saveQueryResult frontmatter", () => {
  it("round-trips a query with newline, quote and trailing backslash", () => {
    const query = 'line one\nline "two"\\';
    const file = saveQueryResult({
      query, timestamp: 1700000000000, source: "memory_search",
      sourceSlugs: ["s"], answerPreview: "x", resultCount: 1,
    });
    expect(file).not.toBeNull();
    const text = readFileSync(file!, "utf8");
    const fm = text.split("---\n")[1];
    expect(parse(fm).query).toBe(query);
  });
});
