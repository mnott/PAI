import { describe, it, expect } from "vitest";
import { countTokens, TOKEN_ENCODING } from "./tokens.js";

describe("countTokens", () => {
  it("returns 0 for empty input", () => {
    expect(countTokens("")).toBe(0);
  });

  it("counts a short known phrase with cl100k_base", () => {
    // "hello world" is two tokens under cl100k_base — pinned so a future
    // encoding swap is caught immediately rather than silently changing
    // every downstream reading.
    expect(countTokens("hello world")).toBe(2);
  });

  it("grows with input length", () => {
    const short = countTokens("one two three");
    const long = countTokens("one two three ".repeat(50));
    expect(long).toBeGreaterThan(short * 10);
  });

  it("does not throw on text containing special-token-shaped substrings", () => {
    expect(() => countTokens("<|endoftext|> hello")).not.toThrow();
    expect(countTokens("<|endoftext|> hello")).toBeGreaterThan(0);
  });

  it("reports the encoding it counts with", () => {
    expect(TOKEN_ENCODING).toBe("cl100k_base");
  });
});
