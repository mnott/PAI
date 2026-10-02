/** The dashboard page: one file, no external assets, rendered with textContent only. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PAI memory</title>
<style>
  :root { color-scheme: dark light; --green:#2e9e5b; --amber:#d99a1c; --red:#d64545; }
  body { font: 15px/1.4 -apple-system, system-ui, sans-serif; margin: 0; padding: 12px; max-width: 760px; }
  h1 { font-size: 18px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 14px; height: 14px; border-radius: 50%; background: #888; display: inline-block; }
  section { border-left: 6px solid #888; padding: 6px 10px; margin: 10px 0; background: rgba(128,128,128,.12); border-radius: 4px; }
  .green { border-color: var(--green); } .amber { border-color: var(--amber); } .red { border-color: var(--red); }
  h2 { font-size: 14px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
  .row { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .k { opacity: .7; } .bad { color: var(--red); font-weight: 600; }
  .bar { height: 12px; background: rgba(128,128,128,.3); border-radius: 6px; overflow: hidden; margin: 4px 0; }
  .bar > div { height: 100%; background: var(--green); }
  .red .bar > div { background: var(--red); }
  #foot { opacity: .6; font-size: 12px; }
</style></head><body>
<h1><span class="dot" id="dot"></span><span>PAI memory</span></h1>
<div id="out">loading…</div>
<div id="foot"></div>
<script>
const out = document.getElementById("out");
const COLORS = { green: "#2e9e5b", amber: "#d99a1c", red: "#d64545" };
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function row(k, v, bad) {
  const r = el("div", "row");
  r.append(el("span", "k", k), el("span", bad ? "bad" : "", v));
  return r;
}
function sec(title, level) {
  const s = el("section", level);
  s.append(el("h2", "", title));
  return s;
}
const n = (x) => (x === null || x === undefined ? "?" : Number(x).toLocaleString());
const when = (t) => (t ? new Date(t).toLocaleString() : "never");
function dur(secs) {
  if (secs === null || secs === undefined) return "?";
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h >= 24 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : h > 0 ? h + "h " + m + "m" : m + "m";
}
function render(s) {
  document.getElementById("dot").style.background = COLORS[s.level];
  const frag = document.createDocumentFragment();

  const d = sec("Daemon", "green");
  d.append(row("pid", String(s.daemon.pid)), row("uptime", dur(s.daemon.uptimeSecs)), row("version", s.daemon.version), row("storage", s.daemon.storage));
  frag.append(d);

  const i = s.index, ix = sec("Index", i.level);
  ix.append(row("files", n(i.files)), row("chunks", n(i.chunks) + (i.countsExact ? "" : " (est.)")));
  ix.append(row("embedded", n(i.embedded) + (i.coverage === null ? "" : " (" + (i.coverage * 100).toFixed(1) + "%)")));
  ix.append(row("bound to", i.binding ? i.binding.backend + (i.binding.model ? " / " + i.binding.model : "") : "none"));
  ix.append(row("configured", i.configured.backend + " / " + i.configured.model));
  if (i.hint) ix.append(row("mismatch", i.hint, true));
  if (i.error) ix.append(row("binding error", i.error, true));
  frag.append(ix);

  for (const j of s.jobs) {
    const js = sec("Job " + j.name, j.level);
    const pct = j.total > 0 ? Math.min(100, (j.done / j.total) * 100) : 0;
    const bar = el("div", "bar"), fill = el("div");
    fill.style.width = pct + "%";
    bar.append(fill);
    js.append(row("phase", j.phase), bar, row("progress", n(j.done) + " / " + n(j.total) + " (" + pct.toFixed(1) + "%)"));
    js.append(row("rate", j.rate === null ? "?" : j.rate.toFixed(1) + " /s"), row("ETA", dur(j.etaSecs)));
    js.append(row("last progress", when(j.lastProgressAt)));
    if (j.stalled) js.append(row("state", "STALLED", true));
    frag.append(js);
  }

  const b = s.backend, bs = sec("Backend", b.level);
  bs.append(row(b.id, b.available === null ? "unknown" : b.available ? "available" : "UNAVAILABLE", b.available === false));
  if (b.reason) bs.append(row("detail", b.reason));
  for (const m of b.loaded || []) bs.append(row(m.name, m.gpuShare === null ? "?" : (m.gpuShare * 100).toFixed(0) + "% GPU"));
  frag.append(bs);

  const ps = sec("Passes", s.passes.some((p) => p.level === "red") ? "red" : "green");
  for (const p of s.passes) {
    const label = p.failure ? "FAILED " + when(p.failure.at) : p.running ? "running" : "ok, last " + when(p.lastEnd);
    ps.append(row(p.name, label, !!p.failure));
    if (p.failure) {
      ps.append(row("  error", p.failure.error, true));
      ps.append(row("  next retry", p.failure.gaveUp ? "gave up until next scheduled run" : when(p.failure.retryAt)));
    }
    if (p.nextAt) ps.append(row("  next scheduled", when(p.nextAt)));
  }
  frag.append(ps);

  out.replaceChildren(frag);
  document.getElementById("foot").textContent = "updated " + new Date(s.generatedAt).toLocaleTimeString() + " · refreshes every 10 s";
}
async function load() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    render(await r.json());
  } catch (e) {
    document.getElementById("dot").style.background = COLORS.red;
    document.getElementById("foot").textContent = "daemon unreachable: " + e.message;
  }
}
load();
setInterval(load, 10000);
</script></body></html>
`;
