#!/bin/bash
# PAI Knowledge OS — pre-compact hook
#
# Called by Claude Code before context compaction.
# Updates session status to 'compacted' and logs the event.
#
# NEVER exits non-zero — this must not interrupt Claude Code.

PAI_OS="pai"

# Bail gracefully if pai is not installed
command -v "$PAI_OS" &>/dev/null || exit 0
command -v sqlite3 &>/dev/null || exit 0

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
# Look up project and latest open session
# ---------------------------------------------------------------------------

PROJECT_ID=$(sqlite3 "$REGISTRY_DB" \
  "SELECT id FROM projects WHERE slug = '$PROJECT_SLUG' LIMIT 1" 2>/dev/null) || exit 0
[ -z "$PROJECT_ID" ] && exit 0

SESSION_ID=$(sqlite3 "$REGISTRY_DB" \
  "SELECT id FROM sessions WHERE project_id = $PROJECT_ID AND status = 'open' ORDER BY created_at DESC LIMIT 1" \
  2>/dev/null) || true

# ---------------------------------------------------------------------------
# Update session status to compacted
# ---------------------------------------------------------------------------

if [ -n "$SESSION_ID" ]; then
  sqlite3 "$REGISTRY_DB" \
    "UPDATE sessions SET status = 'compacted' WHERE id = $SESSION_ID" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Log to compaction_log
# ---------------------------------------------------------------------------

TS=$(date +%s)000

if [ -n "$SESSION_ID" ]; then
  sqlite3 "$REGISTRY_DB" \
    "INSERT INTO compaction_log (project_id, session_id, trigger, files_written, created_at) VALUES ($PROJECT_ID, $SESSION_ID, 'precompact', '', $TS)" \
    2>/dev/null || true
else
  sqlite3 "$REGISTRY_DB" \
    "INSERT INTO compaction_log (project_id, session_id, trigger, files_written, created_at) VALUES ($PROJECT_ID, NULL, 'precompact', '', $TS)" \
    2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Sync Obsidian vault
# ---------------------------------------------------------------------------

"$PAI_OS" obsidian sync 2>/dev/null || true

exit 0
