import { afterEach, describe, expect, it, vi } from "vitest";
import { serves } from "./served-models.js";
import { httpModelsCheck } from "../cli/lib/setups.js";

afterEach(() => vi.unstubAllGlobals());

describe("serves", () => {
  it("an unknown list (no ids) lets the endpoint decide", () => {
    expect(serves(undefined, ["a"])).toBe(true);
  });
  it("a provider with no configured models is up when the server answers", () => {
    expect(serves(["a"], [])).toBe(true);
  });
  it("a served list that matches none of the provider's models is down", () => {
    expect(serves(["a"], ["b"])).toBe(false);
  });
  it("one of several configured models being served is up", () => {
    expect(serves(["a", "b"], ["b"])).toBe(true);
  });
});

describe("httpModelsCheck", () => {
  it("is true on a 200 model list when no models are given", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 }),
    );
    expect(await httpModelsCheck("127.0.0.1", 8035, 500)).toBe(true);
  });
});
