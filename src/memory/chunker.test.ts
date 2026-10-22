import { describe, it, expect } from "vitest";
import { chunkMarkdown, parseHeadings, buildOutline, estimateTokens, stripPrivateTags } from "./chunker.js";

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

describe("chunkMarkdown oversized blocks", () => {
  const opts = { maxTokens: 100, overlap: 0 };

  it("splits many lines without blank lines or sentence ends, keeping line ranges", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} word`);
    const chunks = chunkMarkdown(lines.join("\n"), opts);
    expect(chunks.length).toBeGreaterThan(20);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(110);
      expect(c.text.split("\n")[0]).toBe(lines[c.startLine - 1]);
      expect(c.text.split("\n").at(-1)).toBe(lines[c.endLine - 1]);
    }
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(2000);
  });

  it("splits one long line on whitespace", () => {
    const chunks = chunkMarkdown(Array(3000).fill("word").join(" "), opts);
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(110);
  });

  it("hard-splits text without whitespace (CJK)", () => {
    const chunks = chunkMarkdown("漢".repeat(20000), opts);
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(100 * 6);
    expect(chunks.map((c) => c.text).join("")).toBe("漢".repeat(20000));
  });

  it("sentence splitting keeps original line breaks and real line numbers", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Sentence number ${i + 1} is here. Another one follows.`);
    const chunks = chunkMarkdown(lines.join("\n"), opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.split("\n")[0]).toBe(lines[c.startLine - 1]);
    }
  });
});

describe("private tags", () => {
  it("keeps line numbers aligned with the file", () => {
    const md = "intro\n<private>\nsecret\nmore\n</private>\n## Next\nbody";
    const chunks = chunkMarkdown(md);
    const next = chunks.find((c) => c.text.includes("body"))!;
    expect(next.startLine).toBe(6);
    expect(chunks.some((c) => c.text.includes("secret"))).toBe(false);
    expect(stripPrivateTags(md).split("\n")).toHaveLength(md.split("\n").length);
  });

  it("hides everything after an unclosed tag", () => {
    const chunks = chunkMarkdown("public\n<private>\nhidden\n## H\nalso hidden");
    const all = chunks.map((c) => c.text).join("\n");
    expect(all).toContain("public");
    expect(all).not.toMatch(/hidden/);
  });
});

describe("buildOutline scale", () => {
  it("handles thousands of headings quickly with correct ends", () => {
    const md = Array.from({ length: 20000 }, (_, i) => `## H${i}\nx`).join("\n");
    const t = Date.now();
    const out = buildOutline(md);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(out).toHaveLength(20000);
    expect(out[5]).toMatchObject({ startLine: 11, endLine: 12 });
  });
});
