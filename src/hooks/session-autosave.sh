#!/bin/bash
[ "${PAI_WORKER:-}" = "1" ] && exit 0  # disposable worker: no per-session bookkeeping
# PAI Knowledge OS — rolling session autosave
#
# Fires from live hooks (UserPromptSubmit, PostToolUse) so that a session which
# never gets a model-authored checkpoint still leaves a usable ## Continue
# behind. Ctrl+C kills the process without running any stop hook, and /exit does
# not invoke the model — so an exit-time-only guarantee is no guarantee at all.
# The state has to be written while the session is still running.
#
# Writes in "auto" mode, so a model-authored checkpoint for the same session is
# preserved untouched. This is the floor, never a replacement for the ceiling.
#
# NEVER exits non-zero, NEVER prints — this must not interrupt Claude Code.

PAI_OS="pai"
command -v "$PAI_OS" &>/dev/null || exit 0

# ---------------------------------------------------------------------------
# Shell-side rate limit
# ---------------------------------------------------------------------------
# PostToolUse fires after every single tool call. The CLI rate-limits too, but
# reaching it costs a Node start-up each time — hundreds of milliseconds, paid
# on every tool call in the session. Checking a sentinel's mtime here costs a
# stat, so the expensive path is only taken when it will actually do work.

MIN_GAP_SECONDS="${PAI_AUTOSAVE_MIN_GAP:-240}"

SENTINEL_KEY=$(printf '%s' "$PWD" | tr -c 'a-zA-Z0-9' '-' | tail -c 80)
SENTINEL="${TMPDIR:-/tmp}/pai-autosave-hook-${SENTINEL_KEY}"

if [ -f "$SENTINEL" ]; then
  NOW=$(date +%s)
  # stat is not portable: GNU/Linux uses -c %Y, BSD/macOS uses -f %m. GNU
  # first — BSD's `-f %m` reads as "filesystem status" on GNU and silently
  # succeeds on the wrong thing instead of failing over.
  LAST=$(stat -c %Y "$SENTINEL" 2>/dev/null || stat -f %m "$SENTINEL" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt "$MIN_GAP_SECONDS" ]; then
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Session UUID from the hook payload
# ---------------------------------------------------------------------------
# The UUID decides whether an existing authored checkpoint belongs to this
# session and must be left alone. Without it the comparison falls back to the
# session note filename, which other stop-hook steps rename underneath us.

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

# ---------------------------------------------------------------------------
# Detached run
# ---------------------------------------------------------------------------
# The autosave is best-effort bookkeeping (Node start-up, note lookup, TODO.md
# write in a synced folder). Run synchronously it blocks the user's prompt and
# blows the 30 s hook budget on a loaded machine, so it runs detached and the
# hook returns at once. A lock dir (pid inside) keeps a slow machine from
# piling up concurrent autosaves; a dead pid marks the lock stale.

LOCK="${SENTINEL}.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  LOCK_PID=$(cat "$LOCK/pid" 2>/dev/null || true)
  # no pid yet = the launcher is between mkdir and the pid write: still running
  if [ -z "$LOCK_PID" ] || kill -0 "$LOCK_PID" 2>/dev/null; then
    exit 0
  fi
  rm -rf "$LOCK" 2>/dev/null
  mkdir "$LOCK" 2>/dev/null || exit 0
fi

touch "$SENTINEL" 2>/dev/null || true

ARGS=(--min-gap "$MIN_GAP_SECONDS")
[ -n "$CLAUDE_SESSION_UUID" ] && ARGS=(--session-id "$CLAUDE_SESSION_UUID" "${ARGS[@]}")

# macOS has no setsid; nohup + a subshell with all fds redirected detaches
# the work from the hook's stdio so Claude Code does not wait on it.
(
  trap 'rm -rf "$LOCK"' EXIT
  nohup "$PAI_OS" session autosave "${ARGS[@]}"
) </dev/null >/dev/null 2>&1 &
echo $! > "$LOCK/pid" 2>/dev/null || true

exit 0
