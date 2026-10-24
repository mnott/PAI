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
. "$(dirname "$0")/pai-hook-lib.sh" 2>/dev/null || exit 0

# ---------------------------------------------------------------------------
# Detect current project
# ---------------------------------------------------------------------------

pai_detect_project_slug || exit 0

# ---------------------------------------------------------------------------
# Mark the latest open session compacted and log the event
# ---------------------------------------------------------------------------

"$PAI_OS" hooks-db pre-compact "$PROJECT_SLUG" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Signal the daemon that the vault is stale (it syncs, throttled and at low priority)
# ---------------------------------------------------------------------------

pai_resolve_home
mkdir -p "$PAI_HOME_DIR" 2>/dev/null || true
touch "$PAI_HOME_DIR/.obsidian-dirty" 2>/dev/null || true

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
