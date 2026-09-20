import { describe, it, expect } from "vitest";
import { extractJsonSpan } from "./kg-extraction.js";

describe("extractJsonSpan", () => {
  it("extracts JSON from a code fence not at the exact start of the string", () => {
    const raw = "\n  ```json\n{\"entities\":[],\"relations\":[]}\n```\n";
    const span = extractJsonSpan(raw);

    expect(() => JSON.parse(span)).not.toThrow();
    expect(JSON.parse(span)).toEqual({ entities: [], relations: [] });
  });

  it("extracts JSON surrounded by leading and trailing prose", () => {
    const raw =
      "Here is the extracted data:\n" +
      '{"entities":[{"name":"widget","type":"tool","description":"a thing"}],"relations":[]}\n' +
      "Let me know if you need anything else.";
    const span = extractJsonSpan(raw);

    expect(() => JSON.parse(span)).not.toThrow();
    expect(JSON.parse(span)).toEqual({
      entities: [{ name: "widget", type: "tool", description: "a thing" }],
      relations: [],
    });
  });

  it("does not silently fix a truncated/malformed array", () => {
    const raw = '[{"subject":"a","predicate":"b","object":"c"}, {"subject":"d"';
    const span = extractJsonSpan(raw);

    expect(() => JSON.parse(span)).toThrow();
  });
});
