// Probes which emulation condition reproduces the sideways scroll on the cockpit page.
import { spawn } from "node:child_process";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2];
const port = Number(process.env.MEASURE_PORT || 9341);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=" + process.env.TMPDIR + "/cockpit-probe-profile-" + port, "about:blank"], { stdio: "ignore" });
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
  const gauges = document.getElementById("cloud"); if (gauges) { const kids = [...gauges.children].map(k => Math.round(k.getBoundingClientRect().top)); out.gaugeRows = new Set(kids).size; }
  const groups = document.querySelector(".groups"); if (groups) { const gc = [...groups.children].map(k => Math.round(k.getBoundingClientRect().left)); out.groupCols = new Set(gc).size; }
  for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.right > vw + 1 && r.width > 0) out.wide.push((el.tagName + "#" + el.id + "." + el.className).slice(0, 60) + " right=" + Math.round(r.right) + " w=" + Math.round(r.width)); }
  out.wide = out.wide.slice(0, 8); return JSON.stringify(out);
})()`;
const cases = [
  { name: "dsf2@700", metrics: { width: 700, height: 1000, deviceScaleFactor: 2, mobile: false } },
  { name: "dsf3@700", metrics: { width: 700, height: 1000, deviceScaleFactor: 3, mobile: false } },
  { name: "dsf2@700+zoom1.5", metrics: { width: 700, height: 1000, deviceScaleFactor: 2, mobile: false }, js: "document.documentElement.style.zoom=1.5" },
  { name: "minfont16-svg", metrics: { width: 700, height: 1000, deviceScaleFactor: 1, mobile: false }, js: "var s=document.createElement('style');s.textContent='*{font-size:max(16px,1em)!important}svg text{font-size:16px!important}';document.head.appendChild(s)" },
  { name: "zoom2@700", metrics: { width: 700, height: 1000, deviceScaleFactor: 1, mobile: false }, js: "document.documentElement.style.zoom=2" },
  { name: "minfont20@700", metrics: { width: 700, height: 1000, deviceScaleFactor: 1, mobile: false }, js: "var s=document.createElement('style');s.textContent='*{font-size:max(20px,1em)!important}';document.head.appendChild(s)" },
  { name: "dsf1@700+zoom1.5+minfont16", metrics: { width: 700, height: 1000, deviceScaleFactor: 1, mobile: false }, js: "document.documentElement.style.zoom=1.5;var s=document.createElement('style');s.textContent='*{font-size:max(16px,1em)!important}';document.head.appendChild(s)" },
  { name: "dsf2@700+minfont16", metrics: { width: 700, height: 1000, deviceScaleFactor: 2, mobile: false }, js: "var s=document.createElement('style');s.textContent='*{font-size:max(16px,1em)!important}';document.head.appendChild(s)" },
  { name: "dsf3@700+zoom1.5+minfont16", metrics: { width: 700, height: 1000, deviceScaleFactor: 3, mobile: false }, js: "document.documentElement.style.zoom=1.5;var s=document.createElement('style');s.textContent='*{font-size:max(16px,1em)!important}';document.head.appendChild(s)" },
];
for (const c of cases) {
  await send("Emulation.setDeviceMetricsOverride", c.metrics);
  await send("Page.navigate", { url });
  await sleep(3000);
  if (c.js) { await send("Runtime.evaluate", { expression: c.js }); await sleep(500); }
  const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
  console.log(c.name + ":", r.result?.result?.value ?? JSON.stringify(r));
}
sock.close(); chrome.kill();
