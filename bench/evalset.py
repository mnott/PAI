#!/usr/bin/env python3
"""Helpers for evalset.sh.
  evalset.py prep  <set> <rundir>            write <rundir>/tasks.jsonl (no tests/answers) and an empty <rundir>/out/
  evalset.py grade <set> <rundir> <result.json> <key> <rep> <wall_s> <worker_rc> <worker.json>
Sets: easy, hard (python solutions, hidden tests via codeeval.run_tests), short (exact answers, regex check).
"""
import json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
sys.path.insert(0, HERE)
FILES = {"easy": "codeeval-tasks.jsonl", "hard": "codeeval-hard.jsonl", "short": "cascade-tasks.jsonl"}


def load(s):
    return [json.loads(l) for l in open(os.path.join(DATA, FILES[s])) if l.strip()]


def prep(s, d):
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    with open(os.path.join(d, "tasks.jsonl"), "w") as f:
        for t in load(s):
            keep = ("id", "prompt") if s == "short" else ("id", "entry", "prompt")
            f.write(json.dumps({k: t[k] for k in keep}) + "\n")


def grade(s, d, res, key, rep, wall, wrc, wjson, inst="unknown"):
    from codeeval import run_tests, extract
    tasks, rows = load(s), []
    for t in tasks:
        p = os.path.join(d, "out", f"{t['id']}.{'txt' if s == 'short' else 'py'}")
        if not os.path.exists(p):
            rows.append({"id": t["id"], "ok": False, "err": "missing"}); continue
        txt = open(p, errors="replace").read()
        if s == "short":
            ok = bool(re.search(t["expected_regex"], txt.strip(), re.M)); err = "" if ok else txt.strip()[:80]
        else:
            code = txt
            try:
                compile(code, p, "exec")
            except SyntaxError:
                code = extract(txt) or txt
            ok, err = run_tests(code, t["tests"])
        rows.append({"id": t["id"], "ok": bool(ok), "err": (err or "")[:160]})
    try:
        w = json.load(open(wjson))
    except Exception:
        w = {}
    u = w.get("usage") or {}
    out_tok, dur = u.get("output_tokens"), w.get("duration_ms")
    ntp = sum(r["ok"] for r in rows)
    status = "ok" if w and not w.get("is_error") and wrc == 0 else "error"
    # unparsed tool-call block in the final text = server parser defect, not a model failure
    # PAI's own classification (from evalset.sh); the regex only when no worker id was found
    if inst == "unknown":
        fault = "malformed-tool-call" if re.search(r"<tool_call>[\s\S]{0,200}?(?:<parameter=|</function>)", str(w.get("result") or "")) else None
    else:
        fault = inst or None
    r = {"set": s, "model": key, "rep": int(rep), "status": status, "instrument_fault": fault, "n": len(rows), "passed": ntp,
         "pass_at_1": round(ntp / len(rows), 4), "wall_s": wall, "worker_rc": wrc,
         "duration_ms": dur, "ttft_ms": w.get("ttft_ms"), "output_tokens": out_tok,
         "input_tokens": u.get("input_tokens"), "cache_read_tokens": u.get("cache_read_input_tokens"),
         "num_turns": w.get("num_turns"), "cost_usd": w.get("total_cost_usd"),
         "tok_per_s": round(out_tok / (dur / 1000), 2) if out_tok and dur else None,
         "error": (w.get("result") or "")[:300] if status == "error" else None, "tasks": rows}
    json.dump(r, open(res, "w"), indent=1)
    print(json.dumps({k: v for k, v in r.items() if k != "tasks"}))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "prep":
        prep(a[1], a[2])
    else:
        grade(a[1], a[2], a[3], a[4], a[5], float(a[6]), int(a[7]), a[8], a[9] if len(a) > 9 else "unknown")
