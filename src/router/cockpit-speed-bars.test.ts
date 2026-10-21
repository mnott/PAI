import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const body = COCKPIT_HTML.match(/function speedBars[\s\S]*?\n\}/)![0];
const speedBars = new Function("esc", `${body}\nreturn speedBars;`)(esc) as (sp: unknown[], w: string, loc: Record<string, number>) => string;

const st = (requests: number, ttftP50: number | null, ttftP90: number | null, readTps: number | null, writeTps: number | null) => ({ requests, ttftP50, ttftP90, readTps, writeTps });
const SP = [
  { provider: "anthropic", model: "opus", h1: st(5, 1000, 7200, 400, 50), h24: st(50, 2000, 4000, 800, 40) },
  { provider: "glm", model: "local-m", h1: st(9, 500, 600, 200, 100), h24: st(90, null, null, null, null) },
];
const widths = (html: string) => [...html.matchAll(/<i style="width:([\d.]+)%/g)].map((m) => Number(m[1]));

describe("speed per model bars", () => {
  it("scales each column to its own maximum across models", () => {
    const html = speedBars(SP, "1h", {});
    expect(html).toContain("width:13.9%");
    expect(html).toContain("width:6.9%");
    expect(html).toContain("width:100.0%");
    expect(html).toContain("width:50.0%");
    expect(html).toContain("1.0 s (p90 7.2 s)");
  });

  it("a null value is an empty bar with a dash, never 0", () => {
    const html = speedBars(SP, "24h", {});
    expect(html).toContain("–");
    expect(html).not.toMatch(/\b0\.0 tok\/s/);
    expect(widths(html).length).toBe(3); // only opus has values in h24
  });

  it("window switch picks h1 for 1h and h24 otherwise, and marks LOCAL/CLOUD", () => {
    expect(speedBars(SP, "1h", { glm: 1 })).toContain("last hour");
    expect(speedBars(SP, "1h", { glm: 1 })).toContain("1.0 s");
    for (const w of ["24h", "7d"]) {
      const html = speedBars(SP, w, { glm: 1 });
      expect(html).toContain("last 24 h");
      expect(html).toContain("2.0 s (p90 4.0 s)");
      expect(html).not.toContain("1.0 s (p90");
    }
    const html = speedBars(SP, "1h", { glm: 1 });
    expect(html).toContain(">LOCAL<");
    expect(html).toContain(">CLOUD<");
  });
});
