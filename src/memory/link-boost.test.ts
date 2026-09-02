/**
 * The link boost must help ranking without being able to take it over.
 *
 * Three properties are worth holding, because each corresponds to a way this
 * kind of signal usually goes wrong: it silently reorders when there is no
 * evidence, it lets a densely linked corpus drown similarity, or it counts
 * links that say nothing about the results being ranked.
 */

import { describe, it, expect } from "vitest";
import { applyLinkBoost, type LinkEdge } from "./link-boost.js";
import type { SearchResult } from "./search.js";

const r = (path: string, score: number): SearchResult =>
  ({ path, score, projectId: 1, startLine: 1, endLine: 9 } as SearchResult);

describe("applyLinkBoost", () => {
  it("is a no-op when there are no links", () => {
    const results = [r("a.md", 0.9), r("b.md", 0.5)];
    const out = applyLinkBoost(results, []);
    expect(out.map((x) => x.path)).toEqual(["a.md", "b.md"]);
    expect(out.map((x) => x.score)).toEqual([0.9, 0.5]);
  });

  it("promotes the note the other results link to", () => {
    // b is referred to by both a and c: it is the hub for this query.
    const results = [r("a.md", 0.60), r("b.md", 0.55), r("c.md", 0.50)];
    const edges: LinkEdge[] = [
      { sourcePath: "a.md", targetPath: "b.md" },
      { sourcePath: "c.md", targetPath: "b.md" },
    ];
    const out = applyLinkBoost(results, edges, { weight: 0.5 });
    expect(out[0].path).toBe("b.md");
  });

  it("ignores links to notes outside the result set", () => {
    // Popular elsewhere is not the same as central to this query.
    const results = [r("a.md", 0.9), r("b.md", 0.5)];
    const edges: LinkEdge[] = [
      { sourcePath: "a.md", targetPath: "elsewhere.md" },
      { sourcePath: "outside.md", targetPath: "b.md" },
    ];
    const out = applyLinkBoost(results, edges, { weight: 0.9 });
    expect(out.map((x) => x.path)).toEqual(["a.md", "b.md"]);
  });

  it("cannot move a result by more than the configured weight", () => {
    const results = [r("a.md", 1.0), r("hub.md", 0.9)];
    const edges: LinkEdge[] = [{ sourcePath: "a.md", targetPath: "hub.md" }];
    const out = applyLinkBoost(results, edges, { weight: 0.25 });
    const hub = out.find((x) => x.path === "hub.md")!;
    expect(hub.score).toBeCloseTo(0.9 * 1.25, 10);
    // 1.125 > 1.0, so the hub legitimately overtakes — but only just, and only
    // because the gap was smaller than the weight.
    expect(out[0].path).toBe("hub.md");
  });

  it("ignores self-links", () => {
    const results = [r("a.md", 0.5), r("b.md", 0.4)];
    const edges: LinkEdge[] = [{ sourcePath: "a.md", targetPath: "a.md" }];
    const out = applyLinkBoost(results, edges, { weight: 0.9 });
    expect(out.map((x) => x.score)).toEqual([0.5, 0.4]);
  });

  it("does not mutate its input", () => {
    const results = [r("a.md", 0.5), r("b.md", 0.4)];
    const edges: LinkEdge[] = [{ sourcePath: "a.md", targetPath: "b.md" }];
    applyLinkBoost(results, edges, { weight: 0.5 });
    expect(results.map((x) => x.score)).toEqual([0.5, 0.4]);
  });
});
