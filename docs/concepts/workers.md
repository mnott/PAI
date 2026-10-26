# Workers

A worker is a headless Claude Code process (a run without a terminal UI) that does one task on a provider you
chose, in its own git worktree (a separate checkout of your repository, so your files stay untouched) and its own [pane](panes.md), while you keep
working. Code workers (class `implement`, `complex`, in a git repo) get a
worktree on branch `worker/ID`; `--no-worktree` works in place.

## Lifecycle

The usual sequence is 1. `run`, 2. `ps`, 3. `merge`; the rest are optional.

```
# 1. start
pai worker run --class implement --label 'fix the retry loop' -p 'Fix the retry loop in src/net.ts'
# 2. check
pai worker ps                 # this session's workers, running and finished
pai worker follow ID          # watch one live (no ID: all running)
pai worker pane ID            # open the follow pane
pai worker pending            # finished workers whose work is not merged yet
# 3. merge
pai worker merge ID --verify "<command>"   # merge worker/ID, drop worktree and branch
pai worker gc                 # archive old worktrees under refs/pai-archive/ID
```

- **Salvage.** When a run ends on a kill, time limit or loop stop, uncommitted
  edits in the worktree are committed on the branch (ledger line
  `WORKER-SALVAGE`; the ledger is PAI's log of worker events) so nothing is lost. A loop stop or a time limit with saved work escalates one tier up at once. See [escalation](escalation.md).
- **Merge.** `merge` runs the `--verify` command (or `merge.verify` from
  `workers.yaml`) on the merged tree; non-zero exit reverts the merge and keeps
  the branch. A stub scan always runs. Then it runs `workers.merge.verify`
  (default: `npx tsc --noEmit` plus the kept test core in `tests/KEPT.md`,
  stopped after `workers.merge.verifyTimeoutSec`); a failure reverts the merge
  (`--no-verify-tests` skips it once). When the merge lands in the PAI checkout that
  is running, `dist/` is rebuilt (`--no-build` or `workers.merge.rebuild: false`
  skips it; ledger `WORKER-MERGE-BUILD`; a failed build never reverts the
  merge). Over MCP: `worker_merge`.
  Conflicts only in generated files are regenerated (`workers.merge.generated`,
  `workers.merge.regenerate`), add-only clashes in `workers.merge.union` files
  are union-merged. `discard` throws a branch away.
- **Gc.** `workers.gcOlderThanHours` (6) and `workers.worktreesMaxGb` (20) bound
  leftovers.
- Other verbs: `say` (message a running worker), `goal`, `resume ID TEXT`
  (continue a finished worker's conversation), `replay`, `kill`, `wait`.
- **Kill.** `pai worker kill ID --reason TEXT`: a non-interactive caller
  (a worker, a script, MCP) must give a reason, which is recorded with the
  stop. `say` to a pooled worker queues a note it reads at its next turn.
- **Benchmark runs.** A run labelled benchmark (`bench`, `benchmark`,
  `strata-bench`, night queue) stays on its provider: it never falls through
  to the cloud or escalates to a higher tier, and it is not held by a
  [provider hold](providers.md) or paused by the [battery guard](battery-guard.md).

## The report

A headless worker ends with ONE message in AG2, a compact key=value report format (`--report json` selects
JSON). Example:

```
R
i=fix-retry-loop
r=+
t=Retry+
c=src/net.ts retry loop backs off
p=npx vitest run src/net.test.ts
z=retry capped at 5
```

The keys: `i` id, `r` result, `t` tests, `c` files
changed, `p` proof, `z` one-line note, `x` what is left, `y` why when the result
is not `+`. Result `+` is done and verified; `-` failed; `~` stopped or partial
(work continues or was salvaged); `?` unknown; `!` is an error outcome, handled like `-` (the run falls through to the next route). A malformed report
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

[../worker.md](../worker.md) is the long reference (supervision, config,
chains, sub-workers, MCP, status line); this page is the overview. First run: [First workers](../install/first-workers.md).
