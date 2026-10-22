import { describe, it, expect } from "vitest";
import { buildPgTsQuery } from "./helpers.js";

describe("buildPgTsQuery", () => {
  it("quotes plain words and joins with OR", () => {
    expect(buildPgTsQuery("Acme interview follow-up Alice")).toBe(
      "'acme' | 'interview' | 'follow' | 'alice'"
    );
  });

  it.each(["vector<int>", "a<b", "x:*", "a\\b", "foo-bar ~baz", "a <-> b", "c&d|e!f"])(
    "leaves no tsquery operator characters for %j",
    (q) => {
      const out = buildPgTsQuery(q);
      // Only the OR separator and the quotes around lexemes may remain.
      expect(out.replace(/'[\p{L}\p{N}_]+'/gu, "").replace(/ \| /g, "")).toBe("");
    }
  );

  it("splits vector<int> into two lexemes", () => {
    expect(buildPgTsQuery("vector<int>")).toBe("'vector' | 'int'");
  });

  it("keeps non-ASCII words", () => {
    expect(buildPgTsQuery("Müller 東京")).toBe("'müller' | '東京'");
  });

  it("returns empty for operator-only input", () => {
    expect(buildPgTsQuery("<>:*&|!")).toBe("");
  });
});
