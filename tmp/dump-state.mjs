// Dumps computed styles and the overflowing element chain at zoom 1.5.
import { spawn } from "node:child_process";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2];
const port = Number(process.env.MEASURE_PORT || 9343);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=" + process.env.TMPDIR + "/cockpit-dump-profile-" + port, "about:blank"], { stdio: "ignore" });
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
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(3000);
await send("Runtime.evaluate", { expression: "document.documentElement.style.zoom=1.5" });
await sleep(600);
const probe = `(() => {
  const out = {};
  const g = document.querySelector(".grp-local");
  const cs = getComputedStyle(g);
  out.grpLocal = { width: g.getBoundingClientRect().width, scrollW: g.scrollWidth, minW: cs.minWidth, maxW: cs.maxWidth, flex: cs.flex, zoom: getComputedStyle(document.documentElement).zoom };
  const card = document.getElementById("cloud").closest(".card");
  out.card = { w: card.getBoundingClientRect().width, scrollW: card.scrollWidth, gridCol: getComputedStyle(card).gridColumn, wrap: getComputedStyle(card).overflowWrap };
  const groups = document.querySelector(".groups");
  out.groups = { w: groups.getBoundingClientRect().width, scrollW: groups.scrollWidth, wrap: getComputedStyle(groups).overflowWrap };
  const cloud = document.querySelector(".grp-cloud");
  out.grpCloud = { w: cloud.getBoundingClientRect().width, scrollW: cloud.scrollWidth };
  const gauges = document.getElementById("cloud");
  out.gauges = { w: gauges.getBoundingClientRect().width, scrollW: gauges.scrollWidth };
  const err = document.querySelector('#cloud .gauge .s');
  out.errLine = err ? { w: err.getBoundingClientRect().width, right: err.getBoundingClientRect().right, wrap: getComputedStyle(err).overflowWrap, ws: getComputedStyle(err).whiteSpace } : null;
  const doc = document.documentElement;
  out.doc = { scrollW: doc.scrollWidth, clientW: doc.clientWidth };
  let widest = null;
  for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (!widest || r.right > widest.right) widest = { tag: el.tagName + "." + el.className, right: r.right, w: r.width }; }
  out.widest = widest;
  return JSON.stringify(out);
})()`;
const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r));
sock.close(); chrome.kill();
