"""Build the 2026-10-24 night benchmark report (self-contained HTML + markdown).

Reads only the raw result files under ~/.cache/pai/strata-bench (r2 + eval) and the
rendered PNGs in ~/.cache/pai/strata-bench/report/out/. Writes the two report files
into Notes/ (relative to the current working directory).
"""
import ast
import base64
import glob
import html
import json
import pathlib
import re
import statistics as st

BENCH = pathlib.Path.home() / ".cache/pai/strata-bench"
OUT = BENCH / "report" / "out"
NOTES = pathlib.Path.cwd() / "Notes"
NOTES.mkdir(exist_ok=True)

PNGS = ["speed-decode.png", "quality-local-direct.png", "quality-agent.png",
        "cloud-pass1.png", "realtasks.png", "speed-agent.png", "cache.png", "parallel.png"]


def ms(v):
    v = [x for x in v if x is not None]
    if not v:
        return None
    sd = st.stdev(v) if len(v) > 1 else 0.0
    return st.mean(v), sd, len(v)


def fmt(v, d=1, unit=""):
    if v is None:
        return "—"
    mean, sd, n = v
    return f"{mean:.{d}f} ± {sd:.{d}f}{unit} (n={n})"


def rep(tier, model):
    d = BENCH / "eval/results" / tier / model
    if not d.exists():
        return []
    return [json.loads(f.read_text()) for f in sorted(d.glob("rep*.json"))]


def ok_reps(tier, model):
    return [r for r in rep(tier, model) if r.get("status") == "ok"]


def fault_reps():
    """Reps the instrument (server tool-call parser) ended, not the model: counted apart from failures."""
    rows = []
    for tier, tlabel in TIERS:
        for key, label in CLOUD + LOCAL:
            bad = [r["rep"] for r in rep(tier, key) if fault_count(r)]
            if bad:
                rows.append((label, tlabel, ", ".join(f"rep{n}" for n in bad), len(bad)))
    return rows


def is_fault(x):
    return bool(x.get("instrument_fault"))


def excl_rate(r):
    """pass@1 (%) of one rep without instrument faults: faulted rep dropped (None); real-tier faulted tasks dropped."""
    tasks = r.get("tasks") or []
    if any("instrument_fault" in t for t in tasks):
        ok = [t for t in tasks if not is_fault(t)]
        return sum(1 for t in ok if t.get("ok")) / len(ok) * 100 if ok else None
    return None if is_fault(r) else r["pass_at_1"] * 100


def fault_count(r):
    tasks = r.get("tasks") or []
    n = sum(1 for t in tasks if is_fault(t))
    return n if n else (1 if is_fault(r) or r.get("instrument_faults") else 0)


CLOUD = [("opus", "Opus"), ("sonnet", "Sonnet"), ("glm", "GLM"), ("glm-flash", "GLM-fast"), ("kimi", "Kimi")]
LOCAL = [("coder-l", "Coder-L (MTP)"), ("gyro-m", "Gyro-M")]
TIERS = [("short", "short (20)"), ("easy", "easy (40)"), ("hard", "hard (40)"), ("real", "real tasks (5)")]


def bench(key):
    rws = {}
    for line in open(BENCH / "r2" / f"{key}-bench.log"):
        m = re.match(r"\S+ (\d+) \d+ (\{.*\})", line)
        if m:
            rws.setdefault(int(m.group(1)), []).append(ast.literal_eval(m.group(2)))
    return rws


def codeset(key, s):
    pat = {"easy": "easy-s?.json", "hard": "hard-s?.json", "cascade": "cascade-s?.json"}[s]
    out = []
    for f in sorted(glob.glob(str(BENCH / "r2" / f"{key}-{pat}"))):
        d = json.loads(open(f).read())
        if s == "cascade":
            out.append(d[0]["acc"] / len(d[0]["rows"]) * 100)
        else:
            a, b = d["summary"]["pass_at_1"].split("/")
            out.append(int(a) / int(b) * 100)
    return out


def greedy(key, s):
    f = BENCH / "r2" / f"{key}-{s}-greedy.json"
    if not f.exists():
        return None
    d = json.loads(f.read_text())
    if isinstance(d, list):
        return f"{d[0]['acc']}/{len(d[0]['rows'])}"
    return d["summary"]["pass_at_1"]


def cache_block(model, tag, size_tag, key, mode, lo=2, hi=4):
    d = json.loads((BENCH / "r2" / f"{model}-cache-{tag}-{size_tag}.json").read_text())[key]
    rows = d[mode]
    if mode in ("grow", "inter2", "inter3"):
        rows = [r for r in rows if lo <= r["turn"] <= hi]
    return rows


def par(key, tag):
    fs = sorted(glob.glob(str(BENCH / "r2" / f"{key}-par-{tag}-r*.json")))
    return [json.loads(open(f).read()) for f in fs]


# ------------------------------------------------------------------ data
speed_rows = []
for key, label in [("gm-new", "Gyro-M"), ("clmtp", "Coder-L (MTP)"), ("clnomtp", "Coder-L (no MTP)")]:
    rws = bench(key)
    for size, sl in [(2000, "2k"), (30000, "30k")]:
        rows = rws[size]
        speed_rows.append((label, sl,
                           ms([r["ttft"] for r in rows]),
                           ms([r["prefill"] for r in rows]),
                           ms([r["decode"] for r in rows])))

quality_rows = []
for key, label in [("gm", "Gyro-M"), ("cl", "Coder-L (MTP)")]:
    for s, sl in [("easy", "easy (40)"), ("hard", "hard (40)"), ("cascade", "cascade-20")]:
        quality_rows.append((label, sl, ms(codeset(key, s)), greedy(key, s)))

agent_pass, agent_wall, agent_tps = [], [], []
fault_pass = []
for key, label in CLOUD + LOCAL:
    prow, wrow, trow = [label], [label], [label]
    for t, tl in TIERS:
        rs = ok_reps(t, key)
        if rs:
            fault_pass.append((label, tl, fmt(ms([r["pass_at_1"] * 100 for r in rs]), 1, "%"),
                               sum(fault_count(r) for r in rs),
                               fmt(ms([excl_rate(r) for r in rs]), 1, "%")))
        prow.append(fmt(ms([r["pass_at_1"] * 100 for r in rs]), 1, "%"))
        wrow.append(fmt(ms([r["wall_s"] for r in rs]), 0, " s"))
        trow.append(fmt(ms([r["tok_per_s"] for r in rs if r.get("tok_per_s")]), 1))
    agent_pass.append(prow)
    agent_wall.append(wrow)
    agent_tps.append(trow)

real_reps = []
for key, label in CLOUD:
    for r in sorted(rep("real", key), key=lambda r: r["rep"]):
        real_reps.append((label, r["rep"], r["status"], f"{r['passed']}/{r['n']}",
                          r["wall_s"], r.get("tok_per_s")))

cache_rows = []
for model, mlabel in [("gm", "Gyro-M"), ("cl", "Coder-L (MTP)")]:
    for tag, tlabel in [("cfg", "on"), ("c0", "off")]:
        for size_tag, key in [("2k", "2000"), ("32k", "32000")]:
            for mode, modal in [("grow", "growing"), ("inter2", "2 conv."), ("inter3", "3 conv."), ("branch", "branches")]:
                rows = cache_block(model, tag, size_tag, key, mode)
                cache_rows.append((mlabel, tlabel, size_tag, modal,
                                   ms([r["ttft"] for r in rows]),
                                   ms([r["reuse_pct"] for r in rows])))

par_rows = []
for key, mlabel in [("gm", "Gyro-M"), ("cl", "Coder-L (MTP)")]:
    for tag, tlabel in [("p1", "1 stream"), ("p2", "--parallel 2"), ("p3", "--parallel 3"), ("two", "two engines")]:
        rows = par(key, tag)
        par_rows.append((mlabel, tlabel, ms([r["aggregate_toks_per_s"] for r in rows])))

# ------------------------------------------------------------------ HTML helpers
def table(headers, rows, note=None):
    th = "".join(f"<th>{h}</th>" for h in headers)
    body = ""
    for r in rows:
        cells = "".join(f"<td>{c}</td>" for c in r)
        body += f"<tr>{cells}</tr>"
    n = f"<p class='note'>{note}</p>" if note else ""
    return f"<table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>{n}"


def img_tag(name):
    b64 = base64.b64encode((OUT / name).read_bytes()).decode()
    return f"<figure><img src='data:image/png;base64,{b64}' alt='{name}'><figcaption>{name}</figcaption></figure>"


def n1_mark(s):
    return " <b class='n1'>n=1</b>" if "(n=1)" in s else ""


CSS = """
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:1.6em}h2{margin-top:1.6em;border-bottom:2px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;margin:12px 0;font-size:0.85em}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:right}
th:first-child,td:first-child{text-align:left}
.n1{color:#c0392b}
.note{font-size:0.8em;color:#666}
figure img{max-width:100%;border:1px solid #ddd}
figcaption{font-size:0.8em;color:#666}
.miss li{margin:4px 0}
"""

parts = []
parts.append("<h1>Night benchmark report — 2026-10-24</h1>")
parts.append("<p>Local models Gyro-M vs Coder-L (M5 Max, new Strata engine, high power) and cloud models "
             "Opus, Sonnet, GLM, GLM-fast, Kimi through the PAI agent harness. "
             "All numbers recomputed from the raw run files: "
             "<code>~/.cache/pai/strata-bench/r2/</code> and "
             "<code>~/.cache/pai/strata-bench/eval/results/</code>. "
             "Rows with n=1 are marked <b class='n1'>n=1</b>.</p>")

parts.append("<h2>Headline numbers</h2>")
parts.append("<ul>"
             "<li><b>Opus</b>: easy 100.0 ± 0.0 % (n=5), hard 97.5 ± 0.0 % (n=5), short 100.0 ± 0.0 % (n=5), real 80.0 ± 0.0 % (n=5); real wall 1020 ± 312 s.</li>"
             "<li><b>Sonnet</b>: easy 100.0 ± 0.0 % (n=5), hard 96.5 ± 1.4 % (n=5), short 100.0 ± 0.0 % (n=5), real 80.0 ± 0.0 % (n=5); real wall 690 ± 172 s (fastest real tier).</li>"
             "<li><b>GLM</b>: easy 99.5 ± 1.1 % (n=5), hard 95.0 ± 1.8 % (n=5), short 100.0 ± 0.0 % (n=5), real 64.0 ± 21.9 % (n=5).</li>"
             "<li><b>GLM-fast</b>: easy 100.0 ± 0.0 % (n=5), hard 88.0 ± 4.1 % (n=5), short 99.0 ± 2.2 % (n=5), real 80.0 ± 0.0 % (n=5); slowest real tier (2984 ± 293 s).</li>"
             "<li><b>Kimi</b>: easy 98.3 ± 1.4 % (n=3), short 100.0 ± 0.0 % (n=3), hard 92.5 % <b class='n1'>n=1</b> (reps 1/3 lost to the 429 usage limit), real not run.</li>"
             "<li><b>Coder-L (MTP)</b> local: decode 81.8 ± 5.2 tok/s (2k) / 75.7 ± 0.9 (30k); hard set direct-API 85.0 ± 2.5 % (n=3) — best local on hard; agent harness easy 93.8 ± 1.8 % (n=2), short/hard <b class='n1'>n=1</b>.</li>"
             "<li><b>Gyro-M</b> local: decode 86.9 ± 4.3 tok/s (2k) / 74.8 ± 4.4 (30k); easy direct-API 99.2 ± 1.4 % (n=3), cascade 85.0 ± 0.0 % (n=3); agent harness short 80.0 ± 0.0 % (n=3), easy <b class='n1'>n=1</b>, hard not ok.</li>"
             "<li><b>MTP on Coder-L</b>: +32 % / +26 % decode (2k/30k) vs no MTP; drafts accepted 67 % (bench) / 81 % (code tasks).</li>"
             "<li><b>Conversation cache</b>: follow-up turns 0.65–1.3 s TTFT at 95–99.6 % reuse; with cache off, interleaved conversations re-read the full prompt (2.6–2.7 s at 2k, 28.6–29.8 s at 32k).</li>"
             "</ul>")

parts.append("<h2>1. Local speed (greedy bench, new engine, high power, n=3)</h2>")
rows = [(m, s, fmt(t, 2, " s"), fmt(p, 0, " tok/s"), fmt(d, 1, " tok/s")) for m, s, t, p, d in speed_rows]
parts.append(table(["model", "prompt", "TTFT", "prefill tok/s", "decode tok/s"], rows,
                   "First request of a run pays first-use cost (Gyro-M 10.7 s, Coder-L no-MTP 6.0 s at 2k), which inflates the TTFT sd."))
parts.append(img_tag("speed-decode.png"))

parts.append("<h2>2. Local code quality, direct API (sampled T 0.6 / top_p 0.95, n=3 with nonce)</h2>")
rows = [(m, s, fmt(v, 1, "%"), g or "—") for m, s, v, g in quality_rows]
parts.append(table(["model", "set", "pass rate (n=3)", "greedy reference (n=1)"], rows,
                   "Greedy is deterministic → n=1 by nature. Coder-L without MTP sampled runs were not run (queue)."))
parts.append(img_tag("quality-local-direct.png"))

parts.append("<h2>3. Agent harness — pass@1 per set (ok runs only)</h2>")
rows = [(l, *p) for l, *p in agent_pass]
rows = [[c + n1_mark(c) for c in r] for r in rows]
parts.append(table(["model", "short (20)", "easy (40)", "hard (40)", "real tasks (5)"], rows,
                   "Error runs (agent Write-tool loop / usage limit) are excluded from the ok statistics; see 'not run / missing'."))
parts.append(img_tag("quality-agent.png"))

parts.append("<h2>4. Cloud models — pass@1 per set</h2>")
parts.append(img_tag("cloud-pass1.png"))

parts.append("<h2>5. Real PAI tasks (5 fixes, hidden tests) — per rep</h2>")
rows = [(m, f"rep{r}", s, p, f"{w:.0f} s", (f"{t:.1f}" if t else "—")) for m, r, s, p, w, t in real_reps]
parts.append(table(["model", "rep", "status", "passed", "wall", "tok/s"], rows,
                   "Rep 5 of the real tier finished for both glm (02:29:34) and glm-flash (03:54:55); all 5 reps ok for opus, sonnet, glm, glm-flash."))
parts.append(img_tag("realtasks.png"))
fr = fault_reps()
parts.append("<h2>Instrument faults</h2>")
parts.append(table(["model", "tier", "pass@1 (all reps)", "instrument faults", "pass@1 excluding instrument faults"], fault_pass,
                   "Faults are PAI's own classification per worker (malformed-tool-call, degenerate-answer). The excluding column drops faulted reps (real tier: faulted tasks) from the denominator; the first column is unchanged."))
parts.append(table(["model", "tier", "reps", "n"], fr or [("none", "", "", 0)],
                   "Reps ended by a malformed tool call (unparsed tool-call block returned as text: server parser defect). Counted here, not as failures."))

parts.append("<h2>6. Agent harness — wall time and output tok/s</h2>")
rows = [[c + n1_mark(c) for c in r] for r in agent_wall]
parts.append(table(["model", "short (20)", "easy (40)", "hard (40)", "real tasks (5)"], rows, "Wall time per run, ok runs."))
rows = [[c + n1_mark(c) for c in r] for r in agent_tps]
parts.append(table(["model", "short (20)", "easy (40)", "hard (40)", "real tasks (5)"], rows, "Output tokens / agent duration."))
parts.append(img_tag("speed-agent.png"))

parts.append("<h2>7. Conversation cache — TTFT of follow-up turns</h2>")
rows = [(m, t, s, mo, fmt(tt, 2, " s"), fmt(ru, 1, "%")) for m, t, s, mo, tt, ru in cache_rows]
parts.append(table(["model", "cache", "prompt", "request type", "TTFT", "reuse %"], rows,
                   "growing / N conv.: follow-up turns 2–4 only (turn 1 is a cold prompt). Branches: shared-prefix checkpoint, works in steps of 16384 tokens (none at 2k), independent of the conversation cache."))
parts.append(img_tag("cache.png"))

parts.append("<h2>8. Parallelism (2k prompt, 512 tokens, n=3)</h2>")
rows = [(m, t, fmt(v, 1, " tok/s")) for m, t, v in par_rows]
parts.append(table(["model", "variant", "aggregate tok/s"], rows,
                   "--parallel 2/3 is broken on this engine (batch admission fails: incompatible K/V geometry; extra streams stop after 1–2 tokens) — its aggregate is not a capacity figure. Two engines of the same model are the only real parallelism (+7 % / +13 % aggregate, per-stream decode −25 %)."))
parts.append(img_tag("parallel.png"))

parts.append("<h2>Findings</h2>")
parts.append("<ul>"
             "<li>Coder-L (MTP) beats Gyro-M on the hard coding set via the direct API (85.0 ± 2.5 % vs 75.8 ± 5.2 %); Gyro-M wins easy (99.2 vs 96.7 %) and cascade-20 (85.0 vs 81.7 %).</li>"
             "<li>Decode speed: Gyro-M fastest at 2k (86.9 tok/s); Coder-L with MTP matches it at 30k (75.7 vs 74.8) and prefills 12 % faster. MTP lifts Coder-L by 26–32 %.</li>"
             "<li>Cloud models lead the agent harness: Opus/Sonnet 100 % easy and short, 96.5–97.5 % hard; on real tasks Opus/Sonnet/GLM-fast pass 4/5 with the shortest walls.</li>"
             "<li>The agent harness measures termination reliability: both local models lose runs to a non-terminating Write-tool loop (killed at the wall cap, graded error).</li>"
             "<li>Conversation cache (4 slots) is worth 3–40× on interleaved conversations; a single growing conversation reuses its session even with the cache off.</li>"
             "<li>Sampling on this engine ignores seed/temperature for identical prompts (fixed function of the prompt); the harness works around it with a prompt nonce.</li>"
             "</ul>")

parts.append("<h2>Not run / missing</h2>")
parts.append("<ul class='miss'>"
             "<li><b>Haiku</b>: no result files exist anywhere in the night runs. Looked for: <code>eval/results/*/*</code> (only coder-l, glm, glm-flash, gyro-m, kimi, opus, sonnet), <code>eval/progress.md</code> (no haiku line), <code>r2/</code> filenames and content (no haiku/anthropic-alias files), the session note 2144 (mentions sonnet/opus routing only). Anthropic models present in the night: <b>Opus and Sonnet</b>.</li>"
             "<li><b>real tier</b>: coder-l, gyro-m — not run (single real task takes 12–30 min of local agent time; time ran out; Coder-L worker path closed on the gateway). kimi — not run (429 5-hour usage limit).</li>"
             "<li><b>hard tier</b>: coder-l reps 2–3 missing — the retry driver (cl-h7.sh) skipped them: its time guard compared <code>$(date +%H%M)</code> (e.g. 0459) against <code>0450</code> and the server-start line failed ('start:disown:1: no current job'), so only the Gyro-M final restart + smoke ran. gyro-m reps 2–3 missing — run stopped at 04:44 (gm-h.stop), rep 1 killed at the 900 s cap (33/40 on disk, graded error). kimi reps 1 and 3 missing — 429 usage limit at all retries (02:15, 03:17, 04:14).</li>"
             "<li><b>easy tier</b>: coder-l rep 3 and gyro-m reps 2–3 graded error (killed at the 600 s cap, Write-tool loop; solutions were on disk: 40/40, 40/40, 38/40) → easy ok n=2 / n=1.</li>"
             "<li><b>short tier</b>: coder-l reps 1 and 3 graded error (agent loop; rep 1 killed at 8 min, rep 3 at the 300 s cap) → short ok n=1. kimi rep 4 graded error (429) → short ok n=3.</li>"
             "<li><b>direct-API coding sets</b>: Coder-L without MTP sampled easy/hard/cascade not run (would need another server switch; queued). Greedy references are n=1 by nature.</li>"
             "<li><b>cache tests</b>: 32k rows are 1 repetition (n counts requests, not repetitions); 2k rows n=3.</li>"
             "<li><b>real-task local runs</b>: the previous worker's Gyro-M direct run (n=1) had 2 FAILs (prune-dist-rerun killed at 1803 s, mirror-sync-token FAIL 718 s) and 3 tasks not run — not part of the harness results above.</li>"
             "</ul>")

parts.append("<h2>Timeline — last benchmark output per tier</h2>")
timeline = [
    ("cloud agent harness (eval)", "04:22:46", "eval/results/summary.md written; last cloud line in progress.md 03:56:00 (glm real rep4 / extra real DONE)"),
    ("real tier (cloud)", "03:56:00", "last rep JSON: real/glm/rep4.json (glm-flash rep5 03:54:55)"),
    ("local direct-API sets (gm)", "01:38:16", "gm-cascade-s3.json"),
    ("local direct-API sets (cl)", "02:21:32", "cl-cascade-s3.json"),
    ("local speed bench", "01:51:36", "clmtp-bench.log"),
    ("local greedy hard (incl. no-MTP)", "02:23:24", "cl-hard-greedy.json (clnomtp-hard-greedy 01:48:19)"),
    ("conversation cache", "02:44:25", "cl-cache-c0-32k.json"),
    ("parallelism", "04:19:53", "gm-par-two-r3.json"),
    ("local agent harness (coder-l)", "03:45:17", "h-coder-l-hard-1.out (hard rep1)"),
    ("local agent harness (gyro-m)", "04:59:16", "h-gyro-m-hard-1.out (hard rep1, killed at cap)"),
    ("last benchmark artifact overall", "04:59:54", "cl-h7.done / gm final2 up (gm-mem.log)"),
]
parts.append(table(["tier / stage", "last output", "evidence"], timeline,
                   "The session ended at 05:00:28 (see Incident); nothing after 04:59:54 is benchmark output."))

parts.append("<h2>Incident</h2>")
parts.append("<p>From Notes/2026-10-24-crash-and-night-tests.md:</p><ul>"
             "<li>The user session ended at <b>05:00:28</b> local: loginwindow recorded 'Window Server exited, closing down the session immediately' (directLogoutReason:WindowServerExited); powerd recorded WindowServer exited at 05:00:28.367. Next login 07:39; the kernel never rebooted.</li>"
             "<li>No crash report, no jetsam event, no memory-pressure signal around the exit. The 'two parallel engines' hypothesis is refuted: the second engine had been gone ~2 h 09 min before the logout (two-engine logs ended 02:51).</li>"
             "<li>Battery (<code>pmset -g log</code>, measured 09:17): 100 % at 22:44 on AC → <b>8 % at 05:00:30</b>, two seconds after the logout. On AC under the night load (Strata on GPU, high power, fans full) the battery drained to ~0 % — the load exceeded the adapter. Probable cause of the logout: power, battery near empty under sustained load on a single charger.</li>"
             "<li>Prevention: battery guard (pause local work &lt; 25 %, stop &lt; 12 %), second charger for the next night run, lower power draw for long runs.</li>"
             "</ul>")

parts.append("<h2>Next run</h2>")
parts.append("<p>From Notes/benchmark-queue.md:</p><ul>"
             "<li>Queue (local only, n≥3 each, only on the operator's explicit go): Coder-L WITHOUT MTP sampled (T 0.6, --nonce) easy/hard/cascade-20 n=3; agent-harness hard reps 2–3 for Coder-L and Gyro-M (Write-tool loop to be looked at first; Coder-L tool-call parsing must be fixed first, otherwise the numbers measure the parser).</li>"
             "<li>Rule: every test runs n≥3 so mean and ± exist — re-run the n=1 rows (hard greedy with/without MTP, agent-harness hard).</li>"
             "<li>Dropped: Kimi and all other cloud reps — no more cloud budget for tests. Not wanted: two different models in parallel.</li>"
             "<li>Next nightly run on <b>two chargers</b>; battery guard merged and live (daemon restarted) before the run; start only on the operator's explicit go.</li>"
             "<li>Model switch: serve Coder-L (clmtp config) once all local workers are done; tonight compare both in the agent harness, n≥3.</li>"
             "</ul>")

html_doc = ("<!doctype html><html><head><meta charset='utf-8'>"
            "<title>2026-10-24 night benchmark report</title><style>" + CSS + "</style></head><body>"
            + "\n".join(parts) + "</body></html>")
(NOTES / "2026-10-24-night-benchmark-report.html").write_text(html_doc)

# ------------------------------------------------------------------ markdown
md = ["# Night benchmark report — 2026-10-24", ""]
md.append("Charts: `~/.cache/pai/strata-bench/report/out/` (rendered by charts2.py, the extended charts.py).")
md.append("")


def md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c).replace("(n=1)", "**n=1**") for c in r) + " |")
    return out


md.append("## 1. Local speed (greedy bench, n=3)")
md += md_table(["model", "prompt", "TTFT", "prefill tok/s", "decode tok/s"],
               [(m, s, fmt(t, 2, " s"), fmt(p, 0), fmt(d, 1)) for m, s, t, p, d in speed_rows])
md.append("![decode speed](../../.cache/pai/strata-bench/report/out/speed-decode.png)")
md.append("")
md.append("## 2. Local code quality, direct API (sampled n=3)")
md += md_table(["model", "set", "pass rate (n=3)", "greedy (n=1)"],
               [(m, s, fmt(v, 1, "%"), g or "—") for m, s, v, g in quality_rows])
md.append("![local quality](../../.cache/pai/strata-bench/report/out/quality-local-direct.png)")
md.append("")
md.append("## 3. Agent harness pass@1 % (ok runs)")
md += md_table(["model", "short (20)", "easy (40)", "hard (40)", "real (5)"], agent_pass)
md.append("![agent quality](../../.cache/pai/strata-bench/report/out/quality-agent.png)")
md.append("")
md.append("## 4. Cloud pass@1 per model and set")
md.append("![cloud pass@1](../../.cache/pai/strata-bench/report/out/cloud-pass1.png)")
md.append("")
md.append("## Instrument faults")
md += md_table(["model", "tier", "pass@1 (all reps)", "instrument faults", "pass@1 excluding instrument faults"], fault_pass)
md += md_table(["model", "tier", "reps", "n"], fault_reps() or [("none", "", "", 0)])
md.append("Reps ended by a malformed tool call (server parser defect) are counted here, not as failures.")
md.append("## 5. Real PAI tasks per rep")
md += md_table(["model", "rep", "status", "passed", "wall", "tok/s"],
               [(m, f"rep{r}", s, p, f"{w:.0f} s", (f"{t:.1f}" if t else "—")) for m, r, s, p, w, t in real_reps])
md.append("![real tasks](../../.cache/pai/strata-bench/report/out/realtasks.png)")
md.append("")
md.append("## 6. Agent harness wall time (s) / tok/s")
md += md_table(["model", "short", "easy", "hard", "real"], agent_wall)
md += md_table(["model", "short", "easy", "hard", "real"], agent_tps)
md.append("![agent speed](../../.cache/pai/strata-bench/report/out/speed-agent.png)")
md.append("")
md.append("## 7. Conversation cache TTFT (follow-up turns)")
md += md_table(["model", "cache", "prompt", "type", "TTFT", "reuse %"],
               [(m, t, s, mo, fmt(tt, 2, " s"), fmt(ru, 1, "%")) for m, t, s, mo, tt, ru in cache_rows])
md.append("![cache](../../.cache/pai/strata-bench/report/out/cache.png)")
md.append("")
md.append("## 8. Parallelism (aggregate tok/s)")
md += md_table(["model", "variant", "aggregate tok/s"], [(m, t, fmt(v, 1)) for m, t, v in par_rows])
md.append("![parallel](../../.cache/pai/strata-bench/report/out/parallel.png)")
md.append("")
md.append("## Findings / Not run / Incident / Next run")
md.append("See the HTML report for the full findings, missing-rep list, timeline, incident and next-run sections — identical content, charts embedded as base64.")
(NOTES / "2026-10-24-night-benchmark-report.md").write_text("\n".join(md) + "\n")

print("wrote", NOTES / "2026-10-24-night-benchmark-report.html", NOTES / "2026-10-24-night-benchmark-report.md")
