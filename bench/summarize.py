#!/usr/bin/env python3
"""results/<set>/<model>/rep*.json -> results/summary.json + results/summary.md (mean +/- sd per model x set)."""
import glob, json, os, statistics as st, hashlib
BASE = os.environ.get("BENCH_DIR") or os.path.expanduser("~/.cache/pai/bench")
R = os.path.join(BASE, "results")
W = os.path.join(BASE, "work")
METRICS = ["pass_at_1", "wall_s", "tok_per_s", "ttft_ms"]
SETS = ["easy", "hard", "short", "real"]


def stats(v):
    v = [x for x in v if x is not None]
    if not v:
        return None
    return {"n": len(v), "mean": round(st.mean(v), 4), "sd": round(st.stdev(v), 4) if len(v) > 1 else 0.0,
            "min": round(min(v), 4), "max": round(max(v), 4)}


def digest(s, m, rep):
    """hash of the produced solutions of one rep (identical outputs across reps?)"""
    h = hashlib.sha256()
    if s == "real":
        for p in sorted(glob.glob(f"{W}/real/{m}-rep{rep}/*.diff")):
            h.update(open(p, "rb").read())
    else:
        for p in sorted(glob.glob(f"{W}/{s}/{m}/rep{rep}/out/*")):
            h.update(open(p, "rb").read())
    return h.hexdigest()[:10]


out, models = {}, set()
for s in SETS:
    for d in sorted(glob.glob(f"{R}/{s}/*")):
        m = os.path.basename(d)
        runs = [json.load(open(f)) for f in sorted(glob.glob(d + "/rep*.json"))]
        good = [r for r in runs if r.get("status") == "ok"]
        models.add(m)
        e = {"runs": len(runs), "failed_runs": len(runs) - len(good), "errors": [r.get("error") for r in runs if r.get("status") != "ok"]}
        for k in METRICS:
            e[k] = stats([r.get(k) for r in good])
        e["passed"] = stats([r.get("passed") for r in good])
        e["total_tasks"] = good[0].get("n") if good else None
        e["output_tokens"] = stats([r.get("output_tokens") for r in good])
        e["cost_usd"] = stats([r.get("cost_usd") for r in good])
        digs = [digest(s, m, r["rep"]) for r in good]
        e["identical_outputs_across_reps"] = len(set(digs)) == 1 if len(digs) > 1 else None
        e["per_rep_pass_at_1"] = [r["pass_at_1"] for r in good]
        out.setdefault(m, {})[s] = e
json.dump(out, open(R + "/summary.json", "w"), indent=1)


def cell(e, k, f="{:.2f}", scale=1):
    x = e.get(k) if e else None
    if not x:
        return "-"
    return (f + " +/- " + f).format(x["mean"] * scale, x["sd"] * scale)


lines = ["# Model comparison (mean +/- sd over reps; failed runs excluded)", ""]
for title, k, f, sc in [("pass@1 (%)", "pass_at_1", "{:.1f}", 100), ("wall time per run (s)", "wall_s", "{:.0f}", 1),
                        ("tok/s (output tokens / agent duration)", "tok_per_s", "{:.1f}", 1), ("ttft (ms)", "ttft_ms", "{:.0f}", 1)]:
    lines += [f"## {title}", "", "| model | " + " | ".join(SETS) + " |", "|---|" + "---|" * len(SETS)]
    for m in sorted(models):
        lines.append(f"| {m} | " + " | ".join(cell(out[m].get(s), k, f, sc) for s in SETS) + " |")
    lines.append("")
lines += ["## pass@1 range over reps: min-max as fraction (count of tasks)", "", "| model | " + " | ".join(SETS) + " |", "|---|" + "---|" * len(SETS)]
for m in sorted(models):
    c = []
    for s in SETS:
        e = out[m].get(s)
        if not e or not e["pass_at_1"]:
            c.append("-"); continue
        p, q, n = e["pass_at_1"], e["passed"], e["total_tasks"]
        c.append(f"n={p['n']}: {p['mean']:.3f} (sd {p['sd']:.3f}), min {p['min']:.3f} ({q['min']:.0f}/{n}), max {p['max']:.3f} ({q['max']:.0f}/{n})")
    lines.append(f"| {m} | " + " | ".join(c) + " |")
lines.append("")
lines += ["## errors / unavailable runs per model", ""]
for m in sorted(models):
    msgs = []
    for s in SETS:
        e = out[m].get(s)
        if e and e["failed_runs"]:
            msgs.append(f"{s}: {e['failed_runs']} failed run(s) excluded, e.g. {str(e['errors'][0])[:160]}")
    lines.append(f"- {m}: " + ("; ".join(msgs) if msgs else "no errors"))
lines.append("")
lines += ["## runs (ok/total) and identical outputs across reps", "", "| model | " + " | ".join(SETS) + " |", "|---|" + "---|" * len(SETS)]
for m in sorted(models):
    c = []
    for s in SETS:
        e = out[m].get(s)
        c.append("-" if not e else f"{e['runs'] - e['failed_runs']}/{e['runs']}, same={e['identical_outputs_across_reps']}")
    lines.append(f"| {m} | " + " | ".join(c) + " |")
lines.append("")
open(R + "/summary.md", "w").write("\n".join(lines))
print("\n".join(lines))
