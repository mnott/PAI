# Workers

A worker is a headless Claude Code process that does one task on a provider you
chose, in its own git worktree and its own [pane](panes.md), while you keep
working. Code workers (class `implement`, `complex`, in a git repo) get a
worktree on branch `worker/ID`; `--no-worktree` works in place.

## Lifecycle

```
pai worker run --class implement --label 'fix the retry loop' -p 'Fix the retry loop in src/net.ts'
pai worker ps                 # this session's workers, running and finished
pai worker follow ID          # watch one live (no ID: all running)
pai worker pane ID            # open the follow pane
pai worker pending            # finished workers whose work is not merged yet
pai worker merge ID --verify "<command>"   # merge worker/ID, drop worktree and branch
pai worker gc                 # archive old worktrees under refs/pai-archive/ID
```

- **Salvage.** When a run ends on a kill, time limit or loop stop, uncommitted
  edits in the worktree are committed on the branch (ledger line
  `WORKER-SALVAGE`) so nothing is lost. See [escalation](escalation.md).
- **Merge.** `merge` runs the `--verify` command (or `merge.verify` from
  `workers.yaml`) on the merged tree; non-zero exit reverts the merge and keeps
  the branch. A stub scan always runs. `discard` throws a branch away.
- **Gc.** `workers.gcOlderThanHours` (6) and `workers.worktreesMaxGb` (20) bound
  leftovers.
- Other verbs: `say` (message a running worker), `goal`, `resume ID TEXT`
  (continue a finished worker's conversation), `replay`, `kill`, `wait`.

## The report

A headless worker ends with ONE message in AG2 form (`--report json` selects
JSON). The keys the contract uses: `i` id, `r` result, `t` tests, `c` files
changed, `p` proof, `z` one-line note, `x` what is left, `y` why when the result
is not `+`. Result `+` is done and verified; `-` failed; `~` stopped or partial
(work continues or was salvaged); `?` unknown; `!` is the remaining outcome code. A malformed report
gets one re-ask unless `--no-report-retry`. `follow` and `replay` render it as a
compact block.

## The worker contract

Appended to every headless worker's system prompt:

- the worker owns its task and finishes it in its own process; it never hands the
  whole task to one child and steps back;
- children exist for two things: parallelising independent parts (each a
  self-contained spec) and cheaper bounded sub-tasks (`--class spotcheck` or
  `simple`);
- it owns its children's results: waits for them, verifies, folds them into its
  report; ending the parent's turn kills any child still running.

Nesting is bounded by `workers.tree.maxDepth` (2) and `workers.tree.maxChildren`
(4). A worker passes a question up with `pai worker handoff`, or asks a stronger
model for one sub-task with `pai worker help` (budgeted).

## `pai worker run` essentials

| Flag | Effect |
|---|---|
| `-p TEXT` / `--spec FILE` | The task; use a file for long text. |
| `--class NAME` | Kind of work; picks the [tier](delegation-tiers.md). |
| `--provider`, `--model` | Override the route for this run. |
| `--local`, `--cloud`, `--urgent` | See [routing policy](routing-policy.md). |
| `--label TEXT` | Row name in `ps` and `follow`. |
| `--max-minutes N`, `--deadline HH:MM` | Time limit (default `workers.defaultMaxMinutes`, 60). |
| `--worktree`, `--no-worktree` | Isolated branch or in place. |
| `--mcp NAMES` | MCP servers or sets the worker may use. |
| `--orchestrate` | Plans and reviews; code edits are denied. |
| `--chain draft,implement,review` | Stages run one after the other. |

Unknown options (`--allowedTools`, ...) are handed to `claude`. Every option is
in [../commands/worker.md](../commands/worker.md).

## Reference

[../worker.md](../worker.md) stays as the long reference (supervision, config,
chains, sub-workers, MCP, status line); this page is the overview.
