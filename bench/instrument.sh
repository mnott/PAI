# instrument_of <worker.json> <worker.err>: print PAI's own classification of the run
# (malformed-tool-call | degenerate-answer) or nothing. Never re-implements the detector.
# Since PAI 65dc44f5 the final JSON object of `pai worker run --output-format json` carries `instrument`
# (null = no fault, string = that classification), so it is read straight from worker.json — no id needed.
# Older PAI wrote no such field: fall back to the id-based lookup — the id is taken from
# worker.err ("... for <id>"), else found via claudeSession in the status files. Reads <id>.status endReason,
# else the WORKER-END ledger line's instrument= field. Prints "unknown" when no id is found (caller falls back).
instrument_of() {
  local wj=$1 we=$2 pai=${PAI_HOME:-$HOME/.claude/pai} id sid er ins
  ins=$(jq -r 'if has("instrument") then ((.instrument|type)) else "ABSENT" end' "$wj" 2>/dev/null | tail -1)
  case $ins in
    null) return ;;                                   # new PAI: ran clean, no fault to report
    string) ins=$(jq -r '.instrument' "$wj" 2>/dev/null | tail -1)
            [ -n "$ins" ] && { echo "$ins"; return; } ;;
  esac                                              # ABSENT or bad json → old PAI id path
  id=$(grep -Eo '[0-9]{8}-[0-9]{6}-[0-9]+' "$we" 2>/dev/null | head -1)
  if [ -z "$id" ]; then
    sid=$(jq -r '.session_id // empty' "$wj" 2>/dev/null)
    [ -n "$sid" ] && id=$(grep -l "\"claudeSession\":\"$sid\"" "$pai"/logs/workers/*.status 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null | sed 's/\.status$//')
  fi
  [ -n "$id" ] || { echo unknown; return; }
  er=$(jq -r '.endReason // empty' "$pai/logs/workers/$id.status" 2>/dev/null)
  if [ -z "$er" ]; then
    er=$(grep "WORKER-END id=$id " "$pai/logs/workers/ledger.log" 2>/dev/null | grep -Eo 'instrument=[a-z-]+' | tail -1 | cut -d= -f2)
  fi
  case $er in malformed-tool-call|degenerate-answer) echo "$er";; esac
}
