import { describe, it, expect } from "vitest";
import { chunkMarkdown, parseHeadings, buildOutline, estimateTokens } from "./chunker.js";

describe("parseHeadings", () => {
  it("parses levels 1-6 and ignores headings inside ``` and ~~~ fences", () => {
    const lines = ["# A", "```", "# not", "```", "~~~", "## not either", "~~~", "###### F", "#nospace"];
    expect(parseHeadings(lines).map((h) => [h.level, h.title, h.line])).toEqual([
      [1, "A", 1],
      [6, "F", 8],
    ]);
  });
});

describe("chunkMarkdown headingPath", () => {
  it("gives nested headings the full path and prefixes a breadcrumb", () => {
    const md = "# Top\n\n## Decisions\n\nintro\n\n### Worker routing\n\nbody text\n\n## Other\n\nx\n";
    const chunks = chunkMarkdown(md, { overlap: 0 });
    const routing = chunks.find((c) => c.text.includes("body text"))!;
    expect(routing.headingPath).toEqual(["Top", "Decisions", "Worker routing"]);
    expect(routing.text.startsWith("[Top > Decisions > Worker routing]\n")).toBe(true);
    expect(chunks.find((c) => c.text.includes("\nx"))!.headingPath).toEqual(["Top", "Other"]);
  });

  it("keeps the path on every piece of a split large section, within budget", () => {
    const para = (n: number) => Array.from({ length: 40 }, (_, i) => `word${n}_${i}`).join(" ");
    const md = `## Big\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}\n`;
    const chunks = chunkMarkdown(md, { maxTokens: 60, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.headingPath).toEqual(["Big"]);
      expect(c.text.startsWith("[Big]\n")).toBe(true);
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(60);
    }
  });

  it("does not treat a # line in a code fence as a heading", () => {
    const md = "## Real\n\n```sh\n# comment\n## also comment\n```\n\ntext\n";
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toEqual(["Real"]);
  });

  it("leaves preamble with an empty path and no prefix; hash covers stored text", () => {
    const chunks = chunkMarkdown("just a preamble\n\n## H\n\nbody\n", { overlap: 0 });
    expect(chunks[0]!.headingPath).toEqual([]);
    expect(chunks[0]!.text).toBe("just a preamble");
    expect(chunks[1]!.startLine).toBe(3);
    expect(chunks[1]!.text).toBe("[H]\n## H\n\nbody");
  });
});

describe("buildOutline", () => {
  const md = "pre\n# A\ntext\n## B\nx\n### C\ny\n## D\nz\n# E\n```\n# no\n```\nend\n";

  it("nests by level and computes section end lines", () => {
    const [a, e] = buildOutline(md);
    expect(a).toMatchObject({ title: "A", level: 1, startLine: 2, endLine: 9 });
    expect(a!.children.map((c) => [c.title, c.startLine, c.endLine])).toEqual([["B", 4, 7], ["D", 8, 9]]);
    expect(a!.children[0]!.children[0]).toMatchObject({ title: "C", startLine: 6, endLine: 7, children: [] });
    expect(e).toMatchObject({ title: "E", startLine: 10, endLine: 14, children: [] });
    expect(a!.tokens).toBeGreaterThan(0);
  });
});
