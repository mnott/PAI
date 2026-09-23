#!/bin/bash
[ "${PAI_WORKER:-}" = "1" ] && exit 0  # disposable worker: no per-session bookkeeping
# PAI Knowledge OS — pre-compact hook
#
# Called by Claude Code before context compaction.
# Updates session status to 'compacted' and logs the event.
#
# NEVER exits non-zero — this must not interrupt Claude Code.

PAI_OS="pai"

# Set tab color to working state while compacting
TAB_COLOR="${ADAPTER_DIR:-${PAI_DIR:-$HOME/.claude}}/tab-color-command.sh"
[[ -x "$TAB_COLOR" ]] && "$TAB_COLOR" working

# Bail gracefully if pai is not installed
command -v "$PAI_OS" &>/dev/null || exit 0

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
# Mark the latest open session compacted and log the event
# ---------------------------------------------------------------------------

"$PAI_OS" hooks-db pre-compact "$PROJECT_SLUG" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Sync Obsidian vault
# ---------------------------------------------------------------------------

"$PAI_OS" obsidian sync 2>/dev/null || true

# ---------------------------------------------------------------------------
# Auto-checkpoint before context compression
# ---------------------------------------------------------------------------

"$PAI_OS" session checkpoint "Context compressing — auto-checkpoint" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Generate handover brief before context compression
# ---------------------------------------------------------------------------
# Before compacting context, write a "## Continue" section to project's
# Notes/TODO.md with key items from this session so the next session
# can recover and pick up immediately if context is lost.
# If the command doesn't exist yet, fail gracefully.
#

"$PAI_OS" session handover "$PROJECT_SLUG" latest 2>/dev/null || true

exit 0
