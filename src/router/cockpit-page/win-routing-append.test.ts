/**
 * win/cards-routing.ts — the tier selector appends its pick to the END of the chain
 * (lowest preference); a pick already in the chain does not duplicate or move it.
 * No network, no workers.yaml: rtSet is a stub that records the chain it would write.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("./win/cards-routing.ts", import.meta.url)), "utf8");
const m = src.match(/export const WIN_ROUTING_JS = String\.raw`([\s\S]*?)`;/);
if (!m) throw new Error("WIN_ROUTING_JS not found in win/cards-routing.ts");
const pick = (entries: string[], choice: string): string[] | null => {
  let written: string[] | null = null;
  const body = m[1]!;
  const start = body.indexOf("function rtAppend");
  const end = body.indexOf("Win.registerType(\"rtflow\"");
  const fn = new Function("rtSet", `${body.slice(start, end)}\nreturn rtPick;`)(
    (_c: unknown, _t: string, chain: string[]) => { written = chain; },
  );
  const ctx = { body: { __rt: { tier: "T0", entries, sel: { setValue() {} } } } };
  fn(ctx, choice);
  return written;
};

describe("routing selector", () => {
  it("appends a new pick to the end of the chain", () => {
    expect(pick(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });
  it("does not duplicate or move a pick already in the chain", () => {
    expect(pick(["a", "b"], "a")).toBeNull();
    expect(pick(["a", "b"], "b")).toBeNull();
  });
});
