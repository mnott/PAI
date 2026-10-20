// Measures the cockpit page's widths in headless Chrome at several window widths,
// optionally with page zoom and a forced minimum font size (read-only).
// usage: node measure-cockpit.mjs <url> [widths] [zoom] [minfont]
import { spawn } from "node:child_process";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2];
const widths = (process.argv[3] || "1400,1000,660,480").split(",").map(Number);
const zoom = Number(process.argv[4] || 0); // e.g. 1.5 -> documentElement.style.zoom
const minfont = Number(process.argv[5] || 0); // e.g. 16 -> inject *{font-size:max(16px,1em)!important}
const port = Number(process.env.MEASURE_PORT || 9339);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=" + process.env.TMPDIR + "/cockpit-measure-profile-" + port, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50 && !ws; i++) {
  await sleep(200);
  try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = t.find((x) => x.type === "page"); if (p) ws = p.webSocketDebuggerUrl; } catch {}
}
const sock = new WebSocket(ws);
await new Promise((r) => sock.addEventListener("open", r));
let id = 0; const pending = new Map();
sock.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const probe = `(() => {
  const vw = document.documentElement.clientWidth, out = { vw, docScroll: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth - vw, wide: [] };
  const cloud = document.getElementById("cloud"); const card = cloud && cloud.closest(".card");
  if (card) { const r = card.getBoundingClientRect(); out.cloudCard = { left: Math.round(r.left), right: Math.round(r.right), scrollW: card.scrollWidth, clientW: card.clientWidth }; }
  const header = document.querySelector("header"); if (header) { const r = header.getBoundingClientRect(); out.header = { right: Math.round(r.right), scrollW: header.scrollWidth, clientW: header.clientWidth }; }
  const main = document.querySelector("main"); if (main) out.main = { w: Math.round(main.getBoundingClientRect().width), scrollW: main.scrollWidth, cols: getComputedStyle(main).gridTemplateColumns.split(" ").length, firstCol: getComputedStyle(main).gridTemplateColumns.split(" ")[0] };
  const gauges = document.getElementById("cloud"); if (gauges) { const kids = [...gauges.children].map(k => Math.round(k.getBoundingClientRect().top)); out.gaugeRows = new Set(kids).size; }
  const groups = document.querySelector(".groups"); if (groups) { const gc = [...groups.children].map(k => Math.round(k.getBoundingClientRect().left)); out.groupCols = new Set(gc).size; }
  for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.right > vw + 1 && r.width > 0) out.wide.push((el.tagName + "#" + el.id + "." + el.className).slice(0, 60) + " right=" + Math.round(r.right) + " w=" + Math.round(r.width)); }
  out.wide = out.wide.slice(0, 12); return JSON.stringify(out);
})()`;
for (const w of widths) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(3500);
  if (zoom) await send("Runtime.evaluate", { expression: `document.documentElement.style.zoom=${zoom}` });
  if (minfont) await send("Runtime.evaluate", { expression: `var s=document.createElement('style');s.textContent='*{font-size:max(${minfont}px,1em)!important}';document.head.appendChild(s)` });
  if (zoom || minfont) await sleep(600);
  const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
  console.log(`w=${w} zoom=${zoom || "-"} minfont=${minfont || "-"}:`, r.result?.result?.value ?? JSON.stringify(r));
}
sock.close(); chrome.kill();
