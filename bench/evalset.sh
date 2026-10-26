#!/usr/bin/env bash
# One agent run for (model, set, rep), graded by the harness.
# Usage: evalset.sh <provider> <model|-> <easy|hard|short> <rep> [key]
#   key names the results dir (default: provider, or provider-model); results/<set>/<key>/rep<rep>.json
#   evalset.sh anthropic - easy 1 sonnet        evalset.sh anthropic opus hard 2 opus
#   evalset.sh glm glm-5.3-flash short 1 glm-flash
#   evalset.sh gyro-m - easy 1 gyro-m           (local: only when the orchestrator says so, see README.md)
set -u
E=$(cd "$(dirname "$0")" && pwd); . "$E/instrument.sh"
OUT=${BENCH_DIR:-$HOME/.cache/pai/bench}   # results/ and work/ live here, never in the repo
provider=${1:?provider} model=${2:?model or -} set=${3:?set} rep=${4:?rep}
if [ -n "${5:-}" ]; then key=$5; elif [ "$model" = - ]; then key=$provider; else key=$provider-$model; fi
T=$E/config-eval.template.yaml
unset ANTHROPIC_API_KEY
d=$OUT/work/$set/$key/rep$rep; res=$OUT/results/$set/$key/rep$rep.json
mkdir -p "$OUT/results/$set/$key"; rm -rf "$d"; mkdir -p "$d"
sed "s/__PROVIDER__/$provider/g" "$T" > "$d/config.yaml.new" && mv -f "$d/config.yaml.new" "$d/config.yaml"; export PAI_CONFIG_FILE=$d/config.yaml   # private copy per run: pai_eval db, panes off, routing pinned to the provider, escalation and quota retry off
python3 -I "$E/evalset.py" prep "$set" "$d" || exit 2
if [ "$set" = short ]; then
  what="write ONLY the exact final answer (no explanation, no extra text) to out/<id>.txt"; fields="id, prompt"
else
  what="write ONLY the complete, self-contained Python solution (imports included, entry point named in the task, no tests, no input()) to out/<id>.py"; fields="id, entry, prompt"
fi
cat > "$d/spec.txt" <<SPEC
Solve every task in tasks.jsonl (one JSON object per line: $fields). For task i, $what.
Rules: no tests, no internet, no running code; you have only the Read and Write tools. Read nothing but tasks.jsonl. Write all files in out/ relative to the current directory, one file per task id, and do every task. Finish with a one-line report.
SPEC
margs=(); [ "$model" != - ] && margs=(--model "$model")
t0=$(date +%s)
run() { ( cd "$d" && env -u ITERM_SESSION_ID -u TERM_SESSION_ID -u TMUX -u TMUX_PANE -u ANTHROPIC_API_KEY \
  pai worker run --provider "$provider" ${margs[@]+"${margs[@]}"} --class implement --no-worktree --cwd . --max-minutes 120 \
  --label "eval $key $set rep$rep bench" --spec spec.txt --allowedTools 'Read,Write' --output-format json > worker.json 2> worker.err ); }
run; wrc=$?
wall=$(( $(date +%s) - t0 ))
inst=$(instrument_of "$d/worker.json" "$d/worker.err")   # PAI classification; "unknown" = no id, evalset.py regex fallback
python3 -I "$E/evalset.py" grade "$set" "$d" "$res" "$key" "$rep" "$wall" "$wrc" "$d/worker.json" "$inst"
echo "$(date +%H:%M:%S) $key $set rep$rep $(jq -r '"status=\(.status) pass=\(.passed)/\(.n) wall=\(.wall_s)s tok/s=\(.tok_per_s)"' "$res")" >> "$OUT/progress.md"
