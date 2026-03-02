#!/usr/bin/env bash
# PAI Tab Color State Manager
# Sets iTerm2 tab background color based on Claude Code session state.
# Silently exits on non-iTerm2 terminals.
#
# Usage: tab-color-command.sh <state>
# States: working, completed, awaiting, error, active, reset

[[ -z "$ITERM_SESSION_ID" ]] && exit 0

set_color() {
    printf '\033]6;1;bg;red;brightness;%d\a' "$1"
    printf '\033]6;1;bg;green;brightness;%d\a' "$2"
    printf '\033]6;1;bg;blue;brightness;%d\a' "$3"
}

case "${1:-reset}" in
    working|processing)  set_color 255 158 100 ;;  # Orange
    completed|done)      set_color 158 206 106 ;;  # Green
    awaiting|input)      set_color 125 207 255 ;;  # Cyan/Teal
    error|failed)        set_color 247 118 142 ;;  # Red
    active)              set_color 122 162 247 ;;  # Blue
    reset|*)             printf '\033]6;1;bg;*;default\a' ;;
esac
