// Renders the cloud-only cockpit page to a static file for measurement, with
// realistic gauge content (the live page fills #cloud/#local from fetches; a
// static file needs the same DOM to reproduce the layout bug).
import { writeFileSync } from "node:fs";
import { cockpitHtml } from "./committed-page.ts";

function gauge(l: string, name: string, percent: number): string {
  const r = 44, cx = 60, cy = 56, a = (Math.PI * percent) / 100;
  const x = cx - r * Math.cos(a), y = cy - r * Math.sin(a);
  const arc =
    `<path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="var(--line)" stroke-width="10" stroke-linecap="round"/>` +
    `<path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="var(--ok)" stroke-width="10" stroke-linecap="round"/>`;
  return (
    `<div class="gauge"><svg width="120" height="70" viewBox="0 0 120 70">${arc}` +
    `<text x="60" y="54" text-anchor="middle" style="font-size:16px;font-weight:600;fill:var(--fg)">${percent}%</text></svg>` +
    `<div class="n">${l} ${name}</div><div class="s">resets in 4h 12m</div></div>`
  );
}

const cloud = [
  gauge("anthropic", "claude-opus-5-5", 42),
  gauge("anthropic", "claude-sonnet-5-5", 18),
  gauge("openai-codex", "gpt-5-codex-max", 77),
  gauge("google-gemini", "gemini-3-pro-ultra", 5),
  gauge("anthropic", "claude-haiku-5-5", 63),
  gauge("openai", "gpt-5-mini-high", 31),
].join("");
const local = [
  '<div class="gauge"><div class="n">ollama qwen3-14b-instruct</div><div class="ok">up</div><div class="s">3120 MB RSS · 42 tok/s</div></div>',
  '<div class="gauge"><div class="n">lmstudio gemma-3n-e4b-it</div><div class="ok">up</div><div class="s">1840 MB RSS · 28 tok/s</div></div>',
].join("");

let html = cockpitHtml(["cloud"]);
html = html.replace('<div class="gauges" id="cloud"></div>', `<div class="gauges" id="cloud">${cloud}</div>`);
html = html.replace('<div class="gauges" id="local"></div>', `<div class="gauges" id="local">${local}</div>`);
// simulate the live page's error line: a provider whose usage read failed adds a
// warn span with the error text inside the gauge name (see gauge() in cockpit-page.ts)
html = html.replace(
  '<div class="n">openai-codex gpt-5-codex-max</div>',
  '<div class="n">openai-codex gpt-5-codex-max <span class="warn" title="usage reading timed out after 10s">· 3m old</span></div>',
);
// simulate a provider with an error: gauge() emits a .gauge whose .s line is the
// full error text — one long line that cannot wrap below its own width
html = html.replace(
  '<div class="gauges" id="cloud">',
  '<div class="gauges" id="cloud"><div class="gauge dim" title="upstream refused"><div class="s">anthropic-pro: usage reading failed: connect ECONNREFUSED 127.0.0.1:8790 after 3 retries</div></div>',
);
// simulate Chrome's minimum font size setting: it overrides author font-size
// (including inline styles) with the profile minimum. The long error line is
// the content that then exceeds the card: at 16 px it is ~672 px wide.
const MINFONT = process.env.MINFONT ? Number(process.env.MINFONT) : 0;
if (MINFONT) {
  html = html.replace(
    "</style>",
    `*{font-size:max(${MINFONT}px,1em)!important}\nsvg text{font-size:${MINFONT}px!important}\n.s{white-space:nowrap}\n</style>`,
  );
}
writeFileSync(new URL("./cockpit-cloud.html", import.meta.url), html);
console.log("written", html.length, "bytes");
