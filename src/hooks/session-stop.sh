#!/bin/bash
# PAI Knowledge OS — session-stop hook
#
# Called by Claude Code when a session ends.
# Updates session status to 'completed', sets closed_at, and syncs Obsidian.
#
# NEVER exits non-zero — this must not interrupt Claude Code.

PAI_OS="pai"

# Bail gracefully if pai is not installed
command -v "$PAI_OS" &>/dev/null || exit 0
command -v sqlite3 &>/dev/null || exit 0

# ---------------------------------------------------------------------------
# Read the Claude session UUID from the hook payload
# ---------------------------------------------------------------------------
# Claude Code delivers the Stop event as JSON on stdin, carrying `session_id`.
# That UUID is the only stable handle on this session: the steps below rename
# (`session slug --apply`) and renumber (`session cleanup --execute`) the
# session note, so anything derived from its filename has already changed by
# the time the handover runs. Passing the UUID through is what lets the
# handover recognise a checkpoint `pai pause` wrote minutes earlier instead of
# mistaking it for a stale one and overwriting it.
#
# Read non-blocking: when no payload is piped in, carry on without it.

CLAUDE_SESSION_UUID=""
if [ ! -t 0 ]; then
  HOOK_INPUT=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$HOOK_INPUT" ]; then
    if command -v jq &>/dev/null; then
      CLAUDE_SESSION_UUID=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
    else
      CLAUDE_SESSION_UUID=$(printf '%s' "$HOOK_INPUT" | python3 -c \
        "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || true)
    fi
  fi
fi

REGISTRY_DB="$HOME/.pai/registry.db"
[ -f "$REGISTRY_DB" ] || exit 0

# ---------------------------------------------------------------------------
# Detect current project
# ---------------------------------------------------------------------------

DETECT_JSON=$("$PAI_OS" project detect --json 2>/dev/null) || exit 0
[ -z "$DETECT_JSON" ] && exit 0

# Parse slug — try jq first, fall back to python3
if command -v jq &>/dev/null; then
  PROJECT_SLUG=$(echo "$DETECT_JSON" | jq -r '.slug // empty' 2>/dev/null)
else
  PROJECT_SLUG=$(echo "$DETECT_JSON" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('slug',''))" 2>/dev/null) || true
fi

[ -z "$PROJECT_SLUG" ] && exit 0

# ---------------------------------------------------------------------------
# Look up project and latest open/compacted session
# ---------------------------------------------------------------------------

PROJECT_ID=$(sqlite3 "$REGISTRY_DB" \
  "SELECT id FROM projects WHERE slug = '$PROJECT_SLUG' LIMIT 1" 2>/dev/null) || exit 0
[ -z "$PROJECT_ID" ] && exit 0

SESSION_ID=$(sqlite3 "$REGISTRY_DB" \
  "SELECT id FROM sessions WHERE project_id = $PROJECT_ID AND status IN ('open','compacted') ORDER BY created_at DESC LIMIT 1" \
  2>/dev/null) || true

# ---------------------------------------------------------------------------
# Mark session completed and set closed_at
# ---------------------------------------------------------------------------

if [ -n "$SESSION_ID" ]; then
  TS=$(date +%s)000
  sqlite3 "$REGISTRY_DB" \
    "UPDATE sessions SET status = 'completed', closed_at = $TS WHERE id = $SESSION_ID" \
    2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Auto-generate slug from transcript and rename session note
# ---------------------------------------------------------------------------

"$PAI_OS" session slug "$PROJECT_SLUG" latest --apply 2>/dev/null || true

# ---------------------------------------------------------------------------
# Sync Obsidian vault
# ---------------------------------------------------------------------------

"$PAI_OS" obsidian sync 2>/dev/null || true

# ---------------------------------------------------------------------------
# Clean up empty/stale session notes
# ---------------------------------------------------------------------------

"$PAI_OS" session cleanup --execute 2>/dev/null || true

# ---------------------------------------------------------------------------
# Auto-checkpoint before stop (captures final state)
# ---------------------------------------------------------------------------

"$PAI_OS" session checkpoint "Session ending — auto-checkpoint" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Generate handover brief for next session
# ---------------------------------------------------------------------------
# Write a "## Continue" section to project's Notes/TODO.md with key items
# from this session so the next session can pick up immediately.
# This command will extract insights from the session transcript and append
# a handover section. If the command doesn't exist yet, fail gracefully.
#

if [ -n "$CLAUDE_SESSION_UUID" ]; then
  "$PAI_OS" session handover "$PROJECT_SLUG" latest \
    --session-id "$CLAUDE_SESSION_UUID" 2>/dev/null || true
else
  "$PAI_OS" session handover "$PROJECT_SLUG" latest 2>/dev/null || true
fi

# Set tab color to completed state when session ends
TAB_COLOR="${PAI_DIR:-$HOME/.claude}/tab-color-command.sh"
[[ -x "$TAB_COLOR" ]] && "$TAB_COLOR" completed

exit 0
