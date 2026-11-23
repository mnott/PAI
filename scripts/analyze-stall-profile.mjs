#!/usr/bin/env node
// usage: node scripts/analyze-stall-profile.mjs <file.cpuprofile> [topN]
// Prints top self-time and total-time functions inside the stall's time range.
import fs from "node:fs";
const [file, topArg] = process.argv.slice(2);
if (!file) { console.error("usage: analyze-stall-profile.mjs <file.cpuprofile> [topN]"); process.exit(2); }
const top = Number(topArg ?? 15);
const p = JSON.parse(fs.readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
// sample times (us, profile clock); the last sample is at ~endTime
const t = []; let acc = p.startTime;
for (const d of p.timeDeltas) { acc += d; t.push(acc); }
let from = p.startTime, to = p.endTime;
const s = p.paiStall;
if (s) { to = p.endTime; from = to - s.stallMs * 1000 - 150_000; }
const label = (n) => { const c = n.callFrame; return `${c.functionName || "(anon)"} ${(c.url || "").replace(/^file:\/\//, "")}:${c.lineNumber + 1}`; };
const self = new Map(), total = new Map(); let sum = 0;
p.samples.forEach((id, i) => {
  if (t[i] < from || t[i] > to) return;
  const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i]) / 1000; sum += dt;
  const n = byId.get(id); self.set(label(n), (self.get(label(n)) ?? 0) + dt);
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) { const l = label(byId.get(cur)); if (!seen.has(l)) { seen.add(l); total.set(l, (total.get(l) ?? 0) + dt); } }
});
console.log(`${file}${s ? ` stall ${s.stallMs} ms in flight: ${(s.inflight ?? []).join(", ")}` : ""}\nwindow sampled: ${sum.toFixed(0)} ms`);
const show = (title, m) => { console.log(`\n${title}`); [...m].sort((a, b) => b[1] - a[1]).slice(0, top).forEach(([k, v]) => console.log(`${v.toFixed(0).padStart(7)} ms  ${k}`)); };
show("top self time", self); show("top total time", total);
