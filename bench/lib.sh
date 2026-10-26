# shared helpers; sourced by validate.sh and realtask.sh
BENCH=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# the PAI checkout the tasks come from (read only: clones borrow its objects); default: the repo this bench/ lives in
REPO=${BENCH_REPO:-$(git -C "$BENCH" rev-parse --show-toplevel)}
TREES=$HOME/.cache/pai/realtask-trees
TASKS=${TASKS:-"prune-dist-rerun mirror-sync-token worker-priority session-move-selectors escalate-loopstop"}

# fresh throwaway clone of task $2 at its base (parent of FIX) under $TREES/$1/$2; sets FIX TESTS BASE TREE.
# A shared clone, not a worktree: nothing is ever written into the PAI checkout's .git.
mktree() {
  local label=$1 task=$2
  . "$BENCH/tasks/$task/meta.env"
  TREE=$TREES/$label/$task
  BASE=$(git -C "$REPO" rev-parse "$FIX^") || return 1
  rm -rf "$TREE"; mkdir -p "$TREES/$label"
  git clone -q --shared --no-checkout "$REPO" "$TREE" || { echo "clone failed: $TREE" >&2; return 1; }
  ( cd "$TREE" && git checkout -q --detach "$BASE" && git config user.email bench@localhost && git config user.name bench ) || return 1
  ln -s "$REPO/node_modules" "$TREE/node_modules"
}

# run vitest on $TESTS in $TREE; output to $1, returns vitest's rc. Session env stripped (never bun test).
runtests() {
  ( cd "$TREE" && env -u ITERM_SESSION_ID -u TERM_SESSION_ID -u TMUX -u TMUX_PANE npx vitest run $TESTS > "$1" 2>&1 )
}
