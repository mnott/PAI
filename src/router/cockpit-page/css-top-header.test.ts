import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./css.ts", import.meta.url)), "utf8");

describe("top-level section header", () => {
  it("is a solid --sec bar with --sec-ink text and no left-edge border", () => {
    const rule = css.split("\n").find((l) => l.startsWith('main.win .card[data-depth="0"]>.chead{'));
    expect(rule).toBeDefined();
    expect(rule).toContain("background:var(--sec)");
    expect(rule).toContain("color:var(--sec-ink)");
    expect(css).not.toMatch(/data-depth="0"\][^{]*\{[^}]*border-left/);
  });
});
