# Worker snapshots

A worker runs in its own git worktree on its own branch. If your checkout has
uncommitted changes, the worker still starts from them: PAI commits the dirty
state as a snapshot and branches the worktree from it.

## What is captured

- The index and working tree **including untracked files**, written as one
  floating commit on top of `HEAD` (message `worker <id>: snapshot of uncommitted
  checkout`). No ref moves, your index, working tree and `HEAD` are untouched.
- **Excluded:** PAI's own bookkeeping stays at its `HEAD` state: everything under
  `Notes/` and `TODO*.md` at the project root. Workers never see (or copy back)
  half-written session notes.
- A clean checkout needs no snapshot; the worktree starts at `HEAD`.
- Dependencies are provisioned into the worktree (APFS clone of `node_modules`,
  else a lockfile install), never symlinked.

## Set up for a project

Nothing. Commit or not, workers see what you see. The worker commits on its own
branch (`worker/<id>`); you merge with `pai worker merge`.

## See it working

`pai worker ps` shows the branch; in the worktree, `git log` shows the snapshot
commit as the first commit under the worker's own.

## Troubleshooting

- Worker misses a change in `Notes/` or `TODO*.md`: by design. Commit it, or put
  it in the spec.
- Worktree creation fails (no commits yet, branch exists): the run degrades to
  working in place; the reason is in the worker log.
