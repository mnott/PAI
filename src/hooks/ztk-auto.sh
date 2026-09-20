#!/bin/bash
# Wrapper around ztk rewrite that auto-approves and passes through commands
# whose output ztk would compact lossily (plain-text tools, interpreters,
# pipelines already tailed/headed/counted, or anything requesting JSON output).
# Changes permissionDecision from "ask" to "allow" for everything else.
# Also handles empty responses from ztk (passthrough).

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stdin="$(cat)"

command="$(printf '%s' "$stdin" | jq -r '.tool_input.command // empty' 2>/dev/null)"

if [ -n "$command" ]; then
  decision="$(node "$script_dir/ztk-passthrough.mjs" "$command" 2>/dev/null)"
  if [ "$decision" = "yes" ]; then
    exit 0
  fi
fi

result=$(printf '%s' "$stdin" | ztk rewrite 2>/dev/null)

if [ -z "$result" ]; then
  # ztk returned nothing - allow the command as-is
  echo '{"permissionDecision":"allow"}'
else
  # ztk returned something - change ask to allow
  echo "$result" | sed 's/"permissionDecision":"ask"/"permissionDecision":"allow"/'
fi
