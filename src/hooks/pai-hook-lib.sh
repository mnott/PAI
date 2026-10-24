# PAI Knowledge OS — helpers shared by the shell hooks (sourced, never run).
# Installed next to the hooks as pai-hook-lib.sh. Needs PAI_OS set by the caller.

# Sets CLAUDE_SESSION_UUID from the `session_id` of the JSON payload on stdin
# (empty when no payload is piped in). Reads non-blocking: a hook with nothing
# on stdin must not hang.
pai_read_session_uuid() {
  CLAUDE_SESSION_UUID=""
  [ -t 0 ] && return 0
  local hook_input=""
  if command -v timeout &>/dev/null; then
    hook_input=$(timeout 2 cat 2>/dev/null || true)
  elif command -v perl &>/dev/null; then
    # stock macOS has no GNU timeout
    hook_input=$(perl -e 'alarm 2; exec "cat"' 2>/dev/null || true)
  else
    hook_input=$(cat 2>/dev/null || true)
  fi
  [ -z "$hook_input" ] && return 0
  if command -v jq &>/dev/null; then
    CLAUDE_SESSION_UUID=$(printf '%s' "$hook_input" | jq -r '.session_id // empty' 2>/dev/null || true)
  else
    CLAUDE_SESSION_UUID=$(printf '%s' "$hook_input" | python3 -c \
      "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || true)
  fi
}

# Sets PROJECT_SLUG from `pai project detect`; returns 1 when there is none.
pai_detect_project_slug() {
  local detect_json
  detect_json=$("$PAI_OS" project detect --json 2>/dev/null) || return 1
  [ -z "$detect_json" ] && return 1
  # Parse slug — try jq first, fall back to python3
  if command -v jq &>/dev/null; then
    PROJECT_SLUG=$(echo "$detect_json" | jq -r '.slug // empty' 2>/dev/null)
  else
    PROJECT_SLUG=$(echo "$detect_json" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('slug',''))" 2>/dev/null) || true
  fi
  [ -n "$PROJECT_SLUG" ]
}

# Sets PAI_HOME_DIR: PAI_HOME, else ~/.pai, else the pre-2026-09-19 ~/.claude/pai
# when only that one holds a config (shell can't import src/config/pai-home.ts).
pai_resolve_home() {
  PAI_HOME_DIR="${PAI_HOME:-}"
  if [ -z "$PAI_HOME_DIR" ]; then
    if [ ! -f "$HOME/.pai/config.yaml" ] && [ -f "$HOME/.claude/pai/config.yaml" ]; then PAI_HOME_DIR="$HOME/.claude/pai"; else PAI_HOME_DIR="$HOME/.pai"; fi
  fi
}
