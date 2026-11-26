#!/usr/bin/env bash
# recover_real_rep <out-dir> <key> <rep> <workdir> <label> [error]: write a graded rep json for a real
# series that was stopped (watchdog / engine stall) before its summary line ran. The per-task files
# realset.sh left in the work dir decide each task's fate:
#   <task>.tests.log    written when the hidden tests ran -> FINISHED, graded from it
#   <task>.worker.json  non-empty but no tests.log -> interrupted mid-worker (killed before grading)
#   empty or absent     -> never started / refused at start = not-run
# A finished task is graded from its tests.log ("Tests ... N passed" / "N failed"); an interrupted task
# is failed with reason watchdog/idle; a not-run task is marked not run. status stays "stopped".
recover_real_rep() {
  local out=$1 key=$2 rep=$3 work=$4 label=$5 error=${6:-watchdog-stopped}
  mkdir -p "$out"
  local res="$out/rep$rep.json" seen="" f t rows=""
  # task order: work dir listing first (glob order = realset's TASKS order), then the not-run ones from $TASKS.
  # empty $TASKS must still yield the seen list; $TASKS is only used to append.
  for f in "$work"/*.worker.json; do [ -e "$f" ] || continue; seen="$seen $(basename "$f" .worker.json)"; done
  # TASKS is read as a word list (realset exports it unquoted), but it can carry attacker-controlled text
  # from a stopped run's env: set -f so an unquoted expansion never globs, and no substitution runs —
  # word splitting does not re-evaluate $(), backticks or \ (fault review 2026-11-26). Only tokens that
  # look like task names are appended; a token containing / or whitespace is junk from an injected env.
  set -f
  for t in ${TASKS:-}; do
    # a task name is plain text (alnum, . _ -): anything else ($(), quotes, braces) is an injected token
    case "$t" in *[!A-Za-z0-9._-]*) continue;; esac
    case " $seen " in *" $t "*) ;; *) seen="$seen $t";; esac
  done
  set +f
  for t in $seen; do
    [ -n "$t" ] || continue
    local wj="$work/$t.worker.json" tl="$work/$t.tests.log" st ok reason wall=0 row=""
    # a task name from $TASKS can be arbitrary text ($(), quotes, spaces): only touch files whose basename
    # is exactly this token, never a path built from it (injection review 2026-11-26).
    # a task name from $TASKS can be arbitrary text ($(), quotes, spaces): only touch files whose basename
    # is exactly this token, never a path built from it (injection review 2026-11-26).
    local base=$(basename -- "$t")
    if [ -n "$base" ] && [ "$base" != "." ] && [ "$base" != ".." ]; then
      tl="$work/$base.tests.log"; wj="$work/$base.worker.json"
    else
      tl=""; wj=""
    fi
    if [ -n "$tl" ] && [ -s "$tl" ]; then
      # finished: grade from the hidden-test log (vitest summary; ANSI codes stripped)
      local line passed failed
      line=$(sed 's/\x1b\[[0-9;]*m//g' "$tl" | grep -E '^ *Tests *(.*passed|.*failed)' | tail -1)
      passed=$(printf '%s' "$line" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || echo 0)
      failed=$(printf '%s' "$line" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo 0)
      [ "${passed:-0}" = "" ] && passed=0; [ "${failed:-0}" = "" ] && failed=0
      ok=false; [ "$failed" -eq 0 ] && [ "$passed" -gt 0 ] && ok=true
      st="graded"; reason=""
    elif [ -n "$wj" ] && [ -s "$wj" ]; then
      # worker returned but tests never ran (killed between): interrupted, failed with reason
      st="interrupted"; ok=false; reason="watchdog/idle: tests not graded"
    else
      st="not-run"; ok=false; reason="watchdog/idle: task never started"
    fi
    # wall time from the worker json when present (empty json = never started). NOTE: bash >=5.3 drops a
    # command substitution's result into an array append when the substitution exits non-zero (fault found
    # by the fixture), so build rows as a string and assign to a variable first.
    # a corrupt/truncated worker.json must not break the whole recovery: fall back to 0 (fault review 2026-11-26)
    wall=0
    if [ -s "$wj" ]; then wv=$(jq -r '.duration_ms // 0' "$wj" 2>/dev/null | tail -1); case "$wv" in ''|*[!0-9]*) wv=0;; esac; wall=$wv; fi
    # jq -c alone drops the object to stdout when stdin is empty (jq 1.8.2): feed it explicit null input.
    row=$(printf '' | jq -cn --arg t "$t" --arg st "$st" --argjson ok $ok --arg reason "$reason" --argjson w "${wall:-0}" \
      '{task:$t, status:$st, ok:$ok, reason:$reason, wall_s:($w/1000|round)}' 2>/dev/null)
    # a task token from $TASKS can be arbitrary text (quotes, spaces): the fallback must stay valid JSON
    [ -n "$row" ] || row=$(printf '%s\n' "$t" "$st" "$reason" | jq -c '{task:.[0],status:.[1],ok:false,reason:.[2]}')
    rows="$rows$row"$'\n'
  done
  # empty rows must still produce a valid json (jq -s on no input yields null -> crash)
  if [ -z "$rows" ]; then
    printf '[]' | jq --arg m "$key" --argjson rep "$rep" --arg err "$error" '
      {set:"real", model:$m, rep:$rep, status:"stopped", error:$err, graded:true, n:0, passed:0, tasks:.}' > "$res.tmp" && mv -f "$res.tmp" "$res"
  else
    printf '%s' "$rows" | jq -s --arg m "$key" --argjson rep "$rep" --arg err "$error" '
      {set:"real", model:$m, rep:$rep, status:"stopped", error:$err, graded:true,
       n:(map(select(.status!="not-run"))|length),
       passed:(map(select(.ok))|length),
       tasks:.}' > "$res.tmp" && mv -f "$res.tmp" "$res"
  fi
}
