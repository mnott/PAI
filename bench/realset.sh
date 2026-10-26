#!/usr/bin/env bash
# Real-task set for a cloud model: one worker per PAI task in a throwaway clone, hidden tests judge it (escalation off).
# Usage: realset.sh <provider> <model|-> <rep> [key]   -> results/real/<key>/rep<rep>.json, label <key>-rep<rep>
set -u
. "$(dirname "$0")/lib.sh"; . "$(dirname "$0")/instrument.sh"   # BENCH = this dir (tasks/ = the real tasks), mktree, runtests
provider=${1:?provider} model=${2:?model or -} rep=${3:?rep}
if [ -n "${4:-}" ]; then key=$4; elif [ "$model" = - ]; then key=$provider; else key=$provider-$model; fi
label=$key-rep$rep
unset ANTHROPIC_API_KEY
margs=(); [ "$model" != - ] && margs=(--model "$model")
OUT=${BENCH_DIR:-$HOME/.cache/pai/bench}; cap=${BENCH_REAL_MAX_MIN:-30}   # results/ and work/ live in $OUT; cap = minutes per real task
out=$OUT/results/real/$key; log0=$OUT/work/real/$label; mkdir -p "$out" "$log0"
sed "s/__PROVIDER__/$provider/g" "$BENCH/config-eval.template.yaml" > "$log0/config.yaml.new" && mv -f "$log0/config.yaml.new" "$log0/config.yaml"; export PAI_CONFIG_FILE=$log0/config.yaml   # private copy per run
rows=(); t00=$(date +%s)
for t in $TASKS; do
  mktree "$label" "$t" || continue
  log=$log0/$t; t0=$(date +%s)
  ( cd "$TREE" && env -u ITERM_SESSION_ID -u TERM_SESSION_ID -u TMUX -u TMUX_PANE -u ANTHROPIC_API_KEY \
      pai worker run --provider "$provider" ${margs[@]+"${margs[@]}"} --class implement --no-worktree --cwd . --max-minutes "$cap" \
      --label "real $t $label bench" --spec "$BENCH/tasks/$t/spec.md" --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json \
      > "$log.worker.json" 2> "$log.worker.err" )
  wrc=$?; secs=$(( $(date +%s) - t0 ))
  ( cd "$TREE" && git diff --stat > "$log.diff.stat"; git diff > "$log.diff"; git checkout -q "$FIX" -- $TESTS )
  runtests "$log.tests.log"; trc=$?
  ok=false; [ $trc -eq 0 ] && ok=true
  inst=$(instrument_of "$log.worker.json" "$log.worker.err")   # PAI's classification; "unknown" = no worker id, regex fallback
  row=$(jq -c --arg t "$t" --arg inst "$inst" --argjson ok $ok --argjson s $secs --argjson rc $wrc \
    '{task:$t, ok:$ok, wall_s:$s, worker_rc:$rc, is_error:(.is_error//null), instrument_fault:(if $inst=="unknown" then (if ((.result//"")|test("<tool_call>[\\s\\S]{0,200}?(<parameter=|</function>)")) then "malformed-tool-call" else null end) elif $inst=="" then null else $inst end), duration_ms, ttft_ms, output_tokens:(.usage.output_tokens//null), num_turns, cost_usd:.total_cost_usd}' "$log.worker.json" 2>/dev/null) \
    || row="{\"task\":\"$t\",\"ok\":$ok,\"wall_s\":$secs,\"worker_rc\":$wrc,\"is_error\":true}"
  [ -n "$row" ] || row="{\"task\":\"$t\",\"ok\":$ok,\"wall_s\":$secs,\"worker_rc\":$wrc,\"is_error\":true}"
  rows+=("$row"); rm -rf "$TREE"
done
printf '%s\n' "${rows[@]}" | jq -s --arg m "$key" --argjson rep "$rep" --argjson wall $(( $(date +%s) - t00 )) '
  {set:"real", model:$m, rep:$rep, wall_s:$wall, n:length, passed:(map(select(.ok))|length),
   pass_at_1:((map(select(.ok))|length)/length), instrument_faults:(map(select(.instrument_fault!=null and .instrument_fault!=false))|length),
   status:(if all(.[]; .is_error==true) then "error" else "ok" end),
   duration_ms:(map(.duration_ms//0)|add), output_tokens:(map(.output_tokens//0)|add),
   ttft_ms:(map(.ttft_ms|select(.!=null))|if length>0 then add/length else null end),
   tok_per_s:(((map(.output_tokens//0)|add)/((map(.duration_ms//0)|add)/1000))? // null),
   tasks:.}' > "$out/rep$rep.json"
echo "$(date +%H:%M:%S) $key real rep$rep $(jq -r '"status=\(.status) pass=\(.passed)/\(.n) wall=\(.wall_s)s tok/s=\(.tok_per_s)"' "$out/rep$rep.json")" >> "$OUT/progress.md"
