import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

const stripTags = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

describe("cockpit page compression", () => {
  it("no static text node outside tooltips is longer than 120 characters, and no <p> prose remains", () => {
    const html = stripTags(COCKPIT_HTML);
    const texts = html.split(/<[^>]*>/).map((t) => t.trim()).filter(Boolean);
    expect(texts.filter((t) => t.length > 120)).toEqual([]);
    expect(html).not.toContain("<p ");
    const script = COCKPIT_HTML.match(/<script>[\s\S]*?<\/script>/)![0];
    expect(script).not.toContain("<p ");
  });

  it("every tooltip icon is focusable and carries an aria-label", () => {
    const tags = COCKPIT_HTML.match(/<span class="tip"[^>]*>/g)!;
    expect(tags.length).toBeGreaterThanOrEqual(8);
    for (const t of tags) {
      expect(t).toContain('tabindex="0"');
      expect(t).toMatch(/aria-label="[^"]+"/);
      expect(t).toContain("data-tip=");
    }
    const helper = COCKPIT_HTML.match(/function tip\(t\)\{[^\n]*\}/)![0];
    expect(helper).toContain("tabindex=");
    expect(helper).toContain("aria-label=");
  });

  it("moved explanations live in tooltips", () => {
    for (const w of ["cache_read / (read + write + fresh input)", "* server counter", "TTFT = request sent", "A drop in hits after 5m", "windows differ", "Weighted: tokens times Anthropic price ratios"]) {
      expect(COCKPIT_HTML).toContain(w);
    }
    expect(COCKPIT_HTML).toMatch(/\.tip::after\{content:attr\(data-tip\)/);
  });

  it("local providers that are down sit in one closed <details>; up ones stay visible", () => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const els: Record<string, { innerHTML: string }> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
    const fn = new Function(
      "lim", "$", "esc", "gauge", "ago", "dur",
      `${body}\nrenderLimits();`
    );
    const lim = {
      limits: [
        { provider: "up1", kind: "local", up: true, served: ["m"] },
        ...Array.from({ length: 18 }, (_, i) => ({ provider: `dead${i}`, kind: "local", up: false })),
      ],
    };
    fn(lim, (id: string) => els[id], (s: string) => s, () => "", () => "", () => "");
    const html = els.local!.innerHTML;
    expect(html).toContain("up1");
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain("18 local models down");
    const outside = html.replace(/<details[\s\S]*?<\/details>/, "");
    expect(outside).toContain("up1");
    expect(outside).not.toContain("dead0");
    expect(html.match(/<details[\s\S]*?<\/details>/)![0]).toContain("dead17");
    expect(outside).not.toContain(">down<");
  });
});
