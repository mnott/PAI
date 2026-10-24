"""Charts for the 2026-10-24 night benchmark report.

Extends ~/.cache/pai/strata-bench/report/charts.py (same intent, same output dir)
with the four charts the original script lacked:
  - decode tok/s per model and context size with +/- sd error bars
  - code-quality pass rate per set (easy/hard/cascade) per model with +/-
  - cloud pass@1 per model and set with +/-
  - TTFT with vs without conversation cache
Values are computed from the raw result files:
  - ~/.cache/pai/strata-bench/r2/*.json, *-bench.log   (local speed, cache, parallelism, code sets)
  - ~/.cache/pai/strata-bench/eval/results/<set>/<model>/rep<k>.json  (agent harness, cloud + local)
"""
import ast
import glob
import json
import re
import statistics as st

import pathlib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

BENCH = pathlib.Path.home() / ".cache/pai/strata-bench"
OUT = BENCH / "report" / "out"
OUT.mkdir(parents=True, exist_ok=True)
LOCAL, CLOUD = "#2b7bb9", "#d9822b"


def save(fig, name):
    fig.tight_layout()
    fig.savefig(OUT / name, dpi=150)
    plt.close(fig)


def ms(vals, d=1):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None, None, 0
    mean = st.mean(vals)
    sd = st.stdev(vals) if len(vals) > 1 else 0.0
    return mean, sd, len(vals)


# ---------------------------------------------------------------- raw loaders
def bench_rows(key):
    """{size: [dict(ttft,prefill,decode,...)]} from r2/<key>-bench.log."""
    rows = {}
    for line in open(BENCH / "r2" / f"{key}-bench.log"):
        m = re.match(r"\S+ (\d+) \d+ (\{.*\})", line)
        if m:
            rows.setdefault(int(m.group(1)), []).append(ast.literal_eval(m.group(2)))
    return rows


def codeset_passes(key, setname):
    """Sampled pass counts (n=3, T 0.6) for easy/hard/cascade, direct API."""
    pat = {"easy": "easy-s*.json", "hard": "hard-s*.json", "cascade": "cascade-s*.json"}[setname]
    out = []
    for f in sorted(glob.glob(str(BENCH / "r2" / f"{key}-{pat}"))):
        d = json.loads(open(f).read())
        if setname == "cascade":
            out.append((d[0]["acc"], len(d[0]["rows"])))
        else:
            s = d["summary"]
            a, b = s["pass_at_1"].split("/")
            out.append((int(a), int(b)))
    return out


def eval_reps(tier, model):
    """All rep JSONs of eval/results/<tier>/<model>/."""
    d = BENCH / "eval/results" / tier / model
    if not d.exists():
        return []
    fs = sorted(d.glob("rep*.json"))
    return [json.loads(f.read_text()) for f in fs]


# ---------------------------------------------------------------- 1. agent harness quality (all models)
models = ["Opus", "Sonnet", "GLM", "GLM-fast", "Kimi", "Coder-L", "Gyro-M"]
eval_models = ["opus", "sonnet", "glm", "glm-flash", "kimi", "coder-l", "gyro-m"]
kind = [CLOUD] * 5 + [LOCAL] * 2
fig, ax = plt.subplots(figsize=(11, 4.8))
x = np.arange(len(models))
w = 0.26
for i, (lab, tier) in enumerate([("easy (40)", "easy"), ("hard (40)", "hard"), ("short (20)", "short")]):
    vals, errs, oks = [], [], []
    for em in eval_models:
        reps = [r for r in eval_reps(tier, em) if r.get("status") == "ok"]
        if reps:
            mean, sd, n = ms([r["pass_at_1"] * 100 for r in reps])
            vals.append(mean)
            errs.append(sd)
            oks.append(n)
        else:
            vals.append(0)
            errs.append(0)
            oks.append(None)
    ax.bar(x + (i - 1) * w, vals, w, yerr=errs, capsize=3, color=kind, alpha=(0.45, 1.0, 0.7)[i],
           label=lab, edgecolor="black", linewidth=0.4)
    for j, n in enumerate(oks):
        if n is None:
            ax.text(x[j] + (i - 1) * w, 2, "n/a", ha="center", fontsize=7, rotation=90)
        else:
            ax.text(x[j] + (i - 1) * w, vals[j] + 2, f"n={n}", ha="center", fontsize=6)
ax.set_xticks(x, models)
ax.set_ylabel("pass@1 %")
ax.set_ylim(0, 108)
ax.set_title("Coding sets through the agent harness (pai worker run), mean +/- sd over ok runs\nblue = local (Apple Silicon), orange = cloud")
ax.legend(loc="lower left", fontsize=8)
save(fig, "quality-agent.png")

# ---------------------------------------------------------------- 2. local direct-API quality
fig, ax = plt.subplots(figsize=(7, 4))
sets = ["easy (40)", "hard (40)", "cascade-20"]
gm, cl = [], []
for s in ["easy", "hard", "cascade"]:
    for key, acc in (("gm", gm), ("cl", cl)):
        p = codeset_passes(key, s)
        mean, sd, n = ms([a / b * 100 for a, b in p])
        acc.append((mean, sd))
x = np.arange(3)
ax.bar(x - 0.18, [v for v, _ in gm], 0.36, yerr=[e for _, e in gm], capsize=3, label="Gyro-M", color="#2b7bb9")
ax.bar(x + 0.18, [v for v, _ in cl], 0.36, yerr=[e for _, e in cl], capsize=3, label="Coder-L (MTP)", color="#5fb0e8")
ax.set_xticks(x, sets)
ax.set_ylim(0, 105)
ax.set_ylabel("pass rate % (n=3 samples)")
ax.set_title("Local models, direct API (sampled T 0.6, top_p 0.95, n=3)")
ax.legend()
save(fig, "quality-local-direct.png")

# ---------------------------------------------------------------- 3. local speed: decode tok/s per model x context, +/- sd
names = ["Gyro-M", "Coder-L\n(MTP)", "Coder-L\n(no MTP)"]
cols = ["#2b7bb9", "#5fb0e8", "#9ccbe8"]
keys = ["gm-new", "clmtp", "clnomtp"]
fig, ax = plt.subplots(figsize=(8, 4.5))
x = np.arange(len(names))
w = 0.36
for i, (size, lab) in enumerate([(2000, "2k prompt"), (30000, "30k prompt")]):
    vals, errs, ns = [], [], []
    for key in keys:
        mean, sd, n = ms([r["decode"] for r in bench_rows(key)[size]])
        vals.append(mean)
        errs.append(sd)
        ns.append(n)
    ax.bar(x + (i - 0.5) * w, vals, w, yerr=errs, capsize=3, color=cols, label=lab,
           edgecolor="black", linewidth=0.4)
    for j in range(len(names)):
        ax.text(x[j] + (i - 0.5) * w, vals[j] + 2, f"n={ns[j]}", ha="center", fontsize=7)
ax.set_xticks(x, names)
ax.set_ylabel("decode tok/s")
ax.set_title("Decode speed, local models, new engine, high power, greedy, n=3 per bar")
ax.legend()
save(fig, "speed-decode.png")

# ---------------------------------------------------------------- 4. cloud pass@1 per model and set, +/- sd
fig, ax = plt.subplots(figsize=(10, 4.5))
cloud = ["opus", "sonnet", "glm", "glm-flash", "kimi"]
labels = ["Opus", "Sonnet", "GLM", "GLM-fast", "Kimi"]
x = np.arange(len(cloud))
w = 0.2
for i, (tier, lab) in enumerate([("easy", "easy (40)"), ("hard", "hard (40)"),
                                 ("short", "short (20)"), ("real", "real tasks (5)")]):
    vals, errs, ns = [], [], []
    for m in cloud:
        reps = [r for r in eval_reps(tier, m) if r.get("status") == "ok"]
        if reps:
            mean, sd, n = ms([r["pass_at_1"] * 100 for r in reps])
            vals.append(mean)
            errs.append(sd)
            ns.append(n)
        else:
            vals.append(0)
            errs.append(0)
            ns.append(None)
    ax.bar(x + (i - 1.5) * w, vals, w, yerr=errs, capsize=3, color=CLOUD,
           alpha=(1.0, 0.8, 0.6, 0.45)[i], label=lab, edgecolor="black", linewidth=0.4)
    for j, n in enumerate(ns):
        if n is None:
            ax.text(x[j] + (i - 1.5) * w, 2, "n/a", ha="center", fontsize=7, rotation=90)
        else:
            ax.text(x[j] + (i - 1.5) * w, vals[j] + 2, f"n={n}", ha="center", fontsize=6)
ax.set_xticks(x, labels)
ax.set_ylabel("pass@1 %")
ax.set_ylim(0, 108)
ax.set_title("Cloud models, pass@1 per set (agent harness), mean +/- sd over ok runs")
ax.legend(loc="lower left", fontsize=8)
save(fig, "cloud-pass1.png")

# ---------------------------------------------------------------- 5. TTFT with vs without conversation cache
cases = [
    ("growing\n2k", "2k", "2000", "grow", 2, 4),
    ("2 conv.\n2k", "2k", "2000", "inter2", 2, 4),
    ("3 conv.\n2k", "2k", "2000", "inter3", 2, 4),
    ("growing\n32k", "32k", "32000", "grow", 2, 4),
    ("2 conv.\n32k", "32k", "32000", "inter2", 2, 4),
    ("3 conv.\n32k", "32k", "32000", "inter3", 2, 4),
]
fig, ax = plt.subplots(figsize=(11, 4.5))
x = np.arange(len(cases))
w = 0.2
series = [("Gyro-M cache on", "gm", "cfg", "#2b7bb9"), ("Gyro-M cache off", "gm", "c0", "#9ccbe8"),
          ("Coder-L cache on", "cl", "cfg", "#2e8b57"), ("Coder-L cache off", "cl", "c0", "#9fd8b4")]
means = {s[0]: [] for s in series}
errs = {s[0]: [] for s in series}
for i, (label, model, tag, color) in enumerate(series):
    for _, size_tag, key, mode, lo, hi in cases:
        f = BENCH / "r2" / f"{model}-cache-{tag}-{size_tag}.json"
        d = json.loads(f.read_text())
        block = d[key][mode]
        # follow-up turns only: turn 1 of each conversation is a cold prompt
        block = [r for r in block if lo <= r["turn"] <= hi]
        mean, sd, n = ms([r["ttft"] for r in block])
        means[label].append(mean)
        errs[label].append(sd)
    ax.bar(x + (i - 1.5) * w, means[label], w, yerr=errs[label], capsize=3, label=label, color=color)
ax.set_yscale("log")
ax.set_xticks(x, [c[0] for c in cases])
ax.set_xticklabels([c[0] for c in cases], fontsize=8)
ax.set_ylabel("TTFT of follow-up turns (s, log)")
ax.set_title("Conversation cache: TTFT of follow-up turns, cache on (12288 MiB, 4 slots) vs off (0)\n(growing = turns 2-4 of one conversation; N conv. = all turns 2-4 of interleaved conversations)")
ax.legend(fontsize=8)
save(fig, "cache.png")

# ---------------------------------------------------------------- 6. parallelism
fig, ax = plt.subplots(figsize=(9, 4.5))
var = ["1 stream", "one engine\n--parallel 2", "one engine\n--parallel 3", "two engines"]
x = np.arange(4)
for i, (key, lab, color) in enumerate([("gm", "Gyro-M", "#2b7bb9"), ("cl", "Coder-L (MTP)", "#5fb0e8")]):
    vals, errs = [], []
    for tag in ["p1", "p2", "p3", "two"]:
        fs = sorted(glob.glob(str(BENCH / "r2" / f"{key}-par-{tag}-r*.json")))
        mean, sd, n = ms([json.loads(open(f).read())["aggregate_toks_per_s"] for f in fs])
        vals.append(mean)
        errs.append(sd)
    ax.bar(x + (i - 0.5) * 0.36, vals, 0.36, yerr=errs, capsize=3, label=lab, color=color)
ax.set_xticks(x, var)
ax.set_ylabel("aggregate tok/s (all tokens / wall)")
ax.set_title("Parallel requests, 2k prompt, 512 tokens, n=3\n(--parallel 2/3 is broken on this engine: extra streams stop after 1-2 tokens)")
ax.legend()
save(fig, "parallel.png")

# ---------------------------------------------------------------- 7. real PAI tasks, cloud models
fig, ax = plt.subplots(figsize=(7, 4))
rv, rn = [], []
for m in ["opus", "sonnet", "glm", "glm-flash"]:
    reps = [r for r in eval_reps("real", m) if r.get("status") == "ok"]
    mean, sd, n = ms([r["pass_at_1"] * 100 for r in reps])
    rv.append((mean, sd))
    rn.append(n)
ax.bar(labels[:4], [v for v, _ in rv], yerr=[e for _, e in rv], capsize=4, color=CLOUD)
for j, n in enumerate(rn):
    ax.text(j, rv[j][0] + 2, f"n={n}", ha="center", fontsize=7)
ax.set_xticks(np.arange(4), labels[:4])
ax.set_ylim(0, 105)
ax.set_ylabel("tasks passed %")
ax.set_title("5 real PAI fixes (hidden tests), cloud, n=5 ok runs\n(local models: not run / incomplete)")
save(fig, "realtasks.png")

# ---------------------------------------------------------------- 8. agent-harness speed: wall + tok/s per rep
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.6))
order = ["opus", "sonnet", "glm", "glm-flash", "kimi", "coder-l", "gyro-m"]
nice = ["Opus", "Sonnet", "GLM", "GLM-fast", "Kimi", "Coder-L", "Gyro-M"]
x = np.arange(len(order))
w = 0.26
for i, (tier, lab) in enumerate([("short", "short (20)"), ("easy", "easy (40)"), ("hard", "hard (40)")]):
    wall, tps, ns = [], [], []
    for m in order:
        reps = [r for r in eval_reps(tier, m) if r.get("status") == "ok"]
        if reps:
            wm, wsd, wn = ms([r["wall_s"] for r in reps])
            tm, tsd, tn = ms([r["tok_per_s"] for r in reps if r.get("tok_per_s")])
            wall.append((wm, wsd)); tps.append((tm, tsd)); ns.append(wn)
        else:
            wall.append((0, 0)); tps.append((0, 0)); ns.append(None)
    ax1.bar(x + (i - 1) * w, [v for v, _ in wall], w, yerr=[e for _, e in wall], capsize=3,
            color=kind, alpha=(0.45, 1.0, 0.7)[i], label=lab, edgecolor="black", linewidth=0.4)
    ax2.bar(x + (i - 1) * w, [v for v, _ in tps], w, yerr=[e for _, e in tps], capsize=3,
            color=kind, alpha=(0.45, 1.0, 0.7)[i], label=lab, edgecolor="black", linewidth=0.4)
    for j, n in enumerate(ns):
        if n is None:
            ax1.text(x[j] + (i - 1) * w, 5, "n/a", ha="center", fontsize=6, rotation=90)
            ax2.text(x[j] + (i - 1) * w, 3, "n/a", ha="center", fontsize=6, rotation=90)
        else:
            ax1.text(x[j] + (i - 1) * w, wall[j][0] + 8, f"n={n}", ha="center", fontsize=6)
            ax2.text(x[j] + (i - 1) * w, tps[j][0] + 3, f"n={n}", ha="center", fontsize=6)
for ax, ylab, ttl in ((ax1, "wall time per run (s)", "Wall time per agent run"),
                      (ax2, "output tok/s", "Output tokens / agent duration")):
    ax.set_xticks(x, nice)
    ax.set_ylabel(ylab)
    ax.set_title(ttl, fontsize=10)
    ax.legend(fontsize=7)
fig.suptitle("Agent harness speed (ok runs only), mean +/- sd; blue = local, orange = cloud", fontsize=11)
save(fig, "speed-agent.png")

print("ok", sorted(p.name for p in OUT.glob("*.png")))
