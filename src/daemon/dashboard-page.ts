/** The dashboard page: one self-contained file (inline SVG + CSS), updated in place with textContent/attributes only. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PAI memory</title>
<style>
  :root { color-scheme: light dark; --green:#2e9e5b; --amber:#d99a1c; --red:#d64545; --grey:#8a8f98;
    --bg:#f2f3f5; --card:#fff; --fg:#1b1d21; --mute:#6b7280; --track:rgba(128,128,128,.25); --new:#2e9e5b; --old:#d99a1c; --miss:#8a8f98; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111317; --card:#1b1e24; --fg:#e8eaed; --mute:#9aa0a8; } }
  * { box-sizing: border-box; }
  body { font: 15px/1.4 -apple-system, system-ui, sans-serif; margin: 0; padding: 12px; background: var(--bg); color: var(--fg); }
  main { max-width: 1000px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0; }
  .pill { color: #fff; font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; padding: 4px 12px; border-radius: 999px; background: var(--grey); }
  .pill.green { background: var(--green); } .pill.amber { background: var(--amber); } .pill.red { background: var(--red); }
  #reason { color: var(--mute); flex: 1 1 200px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .wide { grid-column: 1 / -1; }
  @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--card); border-radius: 12px; padding: 12px 14px; border-top: 4px solid var(--grey); box-shadow: 0 1px 3px rgba(0,0,0,.12); min-width: 0; }
  .card.green { border-color: var(--green); } .card.amber { border-color: var(--amber); } .card.red { border-color: var(--red); }
  h2 { font-size: 12px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .06em; color: var(--mute); }
  .k { color: var(--mute); } .bad { color: var(--red); font-weight: 600; }
  .big { font-size: 34px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .unit { font-size: 14px; font-weight: 400; color: var(--mute); }
  .job { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .ring { width: 150px; height: 150px; flex: none; }
  .ring .bg { stroke: var(--track); } .ring .fg { stroke: var(--green); transition: stroke-dashoffset .6s; }
  .ring text { fill: var(--fg); text-anchor: middle; }
  .stats { flex: 1 1 200px; min-width: 0; display: grid; gap: 6px; }
  svg { display: block; }
  .spark { width: 100%; height: 56px; }
  .spark polyline { fill: none; stroke: var(--green); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .spark polygon { fill: var(--green); opacity: .15; }
  .stack { width: 100%; height: 22px; border-radius: 6px; }
  .legend { display: grid; gap: 4px; margin: 8px 0; }
  .legend div { display: flex; align-items: center; gap: 8px; }
  .legend i { width: 12px; height: 12px; border-radius: 3px; flex: none; }
  .legend b { margin-left: auto; font-variant-numeric: tabular-nums; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--grey); display: inline-block; flex: none; }
  .dot.green { background: var(--green); } .dot.amber { background: var(--amber); } .dot.red { background: var(--red); }
  .line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .gauge { width: 100%; height: 14px; border-radius: 7px; }
  .pass { padding: 6px 0; border-top: 1px solid var(--track); }
  .pass:first-of-type { border-top: 0; }
  .pass .tl { width: 100%; height: 16px; }
  .pass .tl line { stroke: var(--track); stroke-width: 3; stroke-linecap: round; }
  .times { display: flex; justify-content: space-between; gap: 8px; color: var(--mute); font-size: 13px; flex-wrap: wrap; }
  .err { color: var(--red); font-size: 13px; word-break: break-word; }
  .kv { display: flex; flex-wrap: wrap; gap: 4px 18px; }
  .kv span span { color: var(--mute); margin-right: 4px; }
  #foot { color: var(--mute); font-size: 12px; margin-top: 12px; }
  [hidden] { display: none !important; }
</style></head><body><main>
<header><h1>PAI memory</h1><span class="pill" id="pill">…</span><span id="reason">loading…</span></header>
<div class="grid">
  <section class="card wide" id="jobs-empty"><h2>Re-embed job</h2><span class="k">no job running</span></section>
  <div class="wide" id="jobs" style="display:contents"></div>

  <section class="card" id="index"><h2>Index</h2>
    <div class="line"><span class="big" id="ix-cov">?</span><span class="unit" id="ix-chunks"></span></div>
    <svg class="stack" id="ix-stack" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="vector distribution">
      <rect id="sg-new" x="0" y="0" width="0" height="10" fill="var(--new)"/>
      <rect id="sg-old" x="0" y="0" width="0" height="10" fill="var(--old)"/>
      <rect id="sg-miss" x="0" y="0" width="0" height="10" fill="var(--miss)"/>
    </svg>
    <div class="legend">
      <div id="lg-new"><i style="background:var(--new)"></i><span>new backend</span><b id="n-new">0</b></div>
      <div id="lg-old"><i style="background:var(--old)"></i><span id="t-old">embedded</span><b id="n-old">0</b></div>
      <div><i style="background:var(--miss)"></i><span>missing</span><b id="n-miss">0</b></div>
    </div>
    <div><span class="k">files</span> <span id="ix-files">?</span></div>
    <div><span class="k">bound to</span> <span id="ix-bound">?</span>, <span class="k">configured</span> <span id="ix-conf">?</span></div>
    <div class="bad" id="ix-hint" hidden></div>
  </section>

  <section class="card" id="backend"><h2>Backend</h2>
    <div class="line"><span class="dot" id="be-dot"></span><b id="be-id">?</b><span id="be-state" class="k"></span></div>
    <div class="k" id="be-reason"></div>
    <div style="margin-top:10px"><span class="k">loaded model</span> <b id="be-model">none</b></div>
    <div class="line" style="margin-top:8px"><span class="big" id="gpu-pct">?</span><span class="unit">GPU</span></div>
    <svg class="gauge" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="GPU share">
      <rect x="0" y="0" width="100" height="10" fill="var(--track)"/>
      <rect id="gpu-bar" x="0" y="0" width="0" height="10" fill="var(--green)"/>
    </svg>
  </section>

  <section class="card" id="passes"><h2>Passes</h2><div id="pass-list"></div></section>

  <section class="card" id="daemon"><h2>Daemon</h2>
    <div class="kv">
      <span><span>pid</span><b id="d-pid">?</b></span><span><span>uptime</span><b id="d-up">?</b></span>
      <span><span>version</span><b id="d-ver">?</b></span><span><span>storage</span><b id="d-sto">?</b></span>
    </div>
  </section>
</div>
<div id="foot"></div>

<template id="job-tpl"><section class="card">
  <h2></h2>
  <div class="job">
    <svg class="ring" viewBox="0 0 120 120" role="img" aria-label="progress">
      <circle class="bg" cx="60" cy="60" r="52" fill="none" stroke-width="12"/>
      <circle class="fg" cx="60" cy="60" r="52" fill="none" stroke-width="12" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="326.73" stroke-dashoffset="326.73"/>
      <text class="pct" x="60" y="68" font-size="24" font-weight="700">0%</text>
    </svg>
    <div class="stats">
      <div><span class="big rate">?</span> <span class="unit">chunks/s</span></div>
      <div><span class="k">done</span> <b class="done">?</b></div>
      <div><span class="k">ETA</span> <b class="eta">?</b> <span class="k fin"></span></div>
      <div class="k phase"></div>
      <div class="bad stall" hidden>STALLED</div>
    </div>
  </div>
  <div class="k" style="margin-top:8px;font-size:12px">rate, last hour</div>
  <svg class="spark" viewBox="0 0 240 56" preserveAspectRatio="none" role="img" aria-label="rate sparkline">
    <polygon points=""/><polyline points=""/>
  </svg>
</section></template>

<script>
const $ = (id) => document.getElementById(id);
const n = (x) => (x === null || x === undefined ? "?" : Number(x).toLocaleString());
const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "never");
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function dur(secs) {
  if (secs === null || secs === undefined) return "?";
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h >= 24 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : h > 0 ? h + "h " + m + "m" : m + "m";
}
const set = (id, text) => { const e = $(id); if (e.textContent !== text) e.textContent = text; };
const lvl = (e, base, level) => { e.className = base + " " + (level || ""); };
const CIRC = 326.73;

function sparkPoints(history) {
  const r = [];
  for (let i = 1; i < history.length; i++) {
    const dt = (history[i].t - history[i - 1].t) / 1000;
    r.push(dt > 0 ? Math.max(0, (history[i].done - history[i - 1].done) / dt) : 0);
  }
  if (r.length < 2) return ["", ""];
  const max = Math.max(...r, 0.001);
  const pts = r.map((v, i) => (i / (r.length - 1) * 240).toFixed(1) + "," + (52 - (v / max) * 48).toFixed(1));
  return [pts.join(" "), "0,56 " + pts.join(" ") + " 240,56"];
}

const jobEls = new Map();
function renderJobs(s) {
  const names = new Set(s.jobs.map((j) => j.name));
  for (const [name, e] of jobEls) if (!names.has(name)) { e.remove(); jobEls.delete(name); }
  $("jobs-empty").hidden = s.jobs.length > 0;
  for (const j of s.jobs) {
    let e = jobEls.get(j.name);
    if (!e) { e = $("job-tpl").content.firstElementChild.cloneNode(true); $("jobs").append(e); jobEls.set(j.name, e); }
    const q = (c) => e.querySelector(c);
    const pct = j.total > 0 ? Math.min(100, (j.done / j.total) * 100) : 0;
    e.className = "card wide " + j.level;
    q("h2").textContent = "Re-embed job " + j.name;
    q(".fg").setAttribute("stroke-dashoffset", String(CIRC * (1 - pct / 100)));
    q(".pct").textContent = pct.toFixed(1) + "%";
    q(".rate").textContent = j.rate === null ? "?" : j.rate.toFixed(1);
    q(".done").textContent = n(j.done) + " / " + n(j.total);
    q(".eta").textContent = j.etaSecs === null ? "?" : dur(j.etaSecs);
    q(".fin").textContent = j.etaSecs === null ? "" : "done about " + clock(s.generatedAt + j.etaSecs * 1000);
    q(".phase").textContent = "phase " + j.phase + ", last progress " + when(j.lastProgressAt);
    q(".stall").hidden = !j.stalled;
    const [line, area] = sparkPoints(j.history || []);
    q("polyline").setAttribute("points", line);
    q("polygon").setAttribute("points", area);
  }
}

function renderIndex(s) {
  const i = s.index, g = i.segments;
  $("index").className = "card " + i.level;
  set("ix-cov", i.coverage === null ? "?" : (i.coverage * 100).toFixed(1) + "%");
  set("ix-chunks", "embedded of " + n(i.chunks) + (i.countsExact ? "" : " (est.)") + " chunks");
  set("ix-files", n(i.files));
  const total = g ? g.fresh + g.old + g.missing : 0;
  const w = (v) => (total > 0 ? (v / total) * 100 : 0);
  const a = w(g ? g.fresh : 0), b = w(g ? g.old : 0), c = w(g ? g.missing : 0);
  const setRect = (id, x, width) => { $(id).setAttribute("x", String(x)); $(id).setAttribute("width", String(width)); };
  setRect("sg-new", 0, a); setRect("sg-old", a, b); setRect("sg-miss", a + b, c);
  const reembed = !!g && s.jobs.some((j) => j.phase !== "done") && g.fresh > 0;
  $("lg-new").hidden = !reembed;
  set("t-old", reembed ? "old backend, still to replace" : "embedded");
  set("n-new", n(g && g.fresh)); set("n-old", n(g && g.old)); set("n-miss", n(g && g.missing));
  const bound = i.binding ? i.binding.backend + (i.binding.model ? " / " + i.binding.model : "") : "none";
  set("ix-bound", bound);
  set("ix-conf", i.configured.backend + " / " + i.configured.model);
  const msg = i.error ? "binding error: " + i.error : i.hint || "";
  $("ix-hint").hidden = !msg; set("ix-hint", msg);
  $("ix-hint").style.color = i.level === "amber" ? "var(--amber)" : "";
}

function renderBackend(s) {
  const b = s.backend, m = b.loaded && b.loaded[0];
  $("backend").className = "card " + b.level;
  lvl($("be-dot"), "dot", b.available === null ? "" : b.available ? "green" : "red");
  set("be-id", b.id);
  set("be-state", b.available === null ? "unknown" : b.available ? "available" : "unavailable");
  set("be-reason", b.reason || "");
  set("be-model", m ? m.name : b.model + " (not loaded)");
  const share = m && m.gpuShare !== null ? m.gpuShare : null;
  set("gpu-pct", share === null ? "?" : (share * 100).toFixed(0) + "%");
  $("gpu-bar").setAttribute("width", String(share === null ? 0 : Math.min(100, share * 100)));
  $("gpu-bar").setAttribute("fill", share !== null && share < 1 ? "var(--amber)" : "var(--green)");
}

const passEls = new Map();
const NS = "http://www.w3.org/2000/svg";
function passRow(name) {
  const e = document.createElement("div"); e.className = "pass";
  e.innerHTML = '<div class="line"><span class="dot"></span><b></b><span class="k st"></span></div>' +
    '<svg class="tl" viewBox="0 0 100 16" preserveAspectRatio="none"><line x1="4" y1="8" x2="96" y2="8"/></svg>' +
    '<div class="times"><span class="last"></span><span class="next"></span></div><div class="err" hidden></div>';
  e.querySelector("b").textContent = name;
  const svg = e.querySelector("svg");
  const mk = (cls, cx) => { const c = document.createElementNS(NS, "ellipse"); c.setAttribute("class", cls); c.setAttribute("cx", cx); c.setAttribute("cy", "8"); c.setAttribute("rx", "2.2"); c.setAttribute("ry", "5"); svg.append(c); return c; };
  mk("m-last", "4"); mk("m-next", "96");
  return e;
}
function renderPasses(s) {
  $("passes").className = "card " + (s.passes.some((p) => p.level === "red") ? "red" : "green");
  for (const p of s.passes) {
    let e = passEls.get(p.name);
    if (!e) { e = passRow(p.name); $("pass-list").append(e); passEls.set(p.name, e); }
    const q = (c) => e.querySelector(c);
    const state = p.failure ? "red" : p.running ? "amber" : "green";
    lvl(q(".dot"), "dot", state);
    q(".st").textContent = p.failure ? "failed" : p.running ? "running" : "ok";
    q(".last").textContent = "last " + (p.lastEnd ? when(p.lastEnd) : "none since start");
    q(".next").textContent = p.nextAt ? "next " + when(p.nextAt) : "";
    const col = "var(--" + state + ")";
    q(".m-last").setAttribute("fill", col);
    q(".m-next").setAttribute("fill", "none"); q(".m-next").setAttribute("stroke", "var(--grey)"); q(".m-next").setAttribute("stroke-width", "1.5");
    q(".m-next").style.display = p.nextAt ? "" : "none";
    const err = q(".err");
    err.hidden = !p.failure;
    if (p.failure) err.textContent = p.failure.error + " (" + (p.failure.gaveUp ? "gave up until next scheduled run" : "retry " + when(p.failure.retryAt)) + ")";
  }
}

function render(s) {
  lvl($("pill"), "pill", s.level);
  set("pill", s.level === "green" ? "healthy" : s.level === "amber" ? "attention" : "problem");
  set("reason", s.reason);
  renderJobs(s); renderIndex(s); renderBackend(s); renderPasses(s);
  set("d-pid", String(s.daemon.pid)); set("d-up", dur(s.daemon.uptimeSecs));
  set("d-ver", s.daemon.version); set("d-sto", s.daemon.storage);
  set("foot", "updated " + new Date(s.generatedAt).toLocaleTimeString() + " · refreshes every 10 s");
}
async function load() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    render(await r.json());
  } catch (e) {
    lvl($("pill"), "pill", "red"); set("pill", "unreachable");
    set("reason", "daemon unreachable: " + e.message);
  }
}
load();
setInterval(load, 10000);
</script></main></body></html>
`;
