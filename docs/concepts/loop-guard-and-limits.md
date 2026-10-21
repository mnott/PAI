# Loop guard and limits

A worker that repeats a command which gets it nowhere burns tokens and time. PAI
stops that with two layers: a hook that denies the repeat, and a supervisor that
watches the stream for failing calls. None of the thresholds below is a config
key; they are fixed in code.

## The loop guard (PreToolUse hook)

A call counts as a **repeat** when, since the last edit (Edit, Write, MultiEdit,
NotebookEdit), it is at least 90% similar to an earlier call **and** the earlier
call returned a result at least 90% similar to the one before it. Repeats that
make progress never count: a similar command whose result changes (polling,
tailing, a retry that succeeds, the same command over different files) is
progress, and waiting verbs and bounded sleeps are exempt.

- **Denial.** After 4 similar calls with similar results, the next one (the 5th)
  is denied with: "loop guard: you ran this command 4 times with the same result
  and nothing changed. Stop repeating it." The worker is told to commit and
  report, or to report the blocker. When the repeated call only reads (Read,
  Grep, Glob, or a read-only shell command such as `grep`, `sed -n`, `cat`), the
  denial also hands back that call's last output, trimmed to
  `workers.loopGuard.echoLines` lines (default 40) and
  `workers.loopGuard.echoChars` characters (default 3000), with lines that look
  like secrets masked, so the worker can go on without asking again.
  When the denied repeat is a runner command (tests, builds; the "without
  changing anything in the worktree" rule), the denial hands back the end of its
  last output instead ("Its last output ended with:"): the last
  `workers.loopGuard.echoRunnerLines` lines (default 40) within `echoChars`,
  secrets masked, followed by "Read the failure above and change code or the
  test before running it again."
- **Content fingerprint.** For runner commands (tests, builds), editing files
  through Bash counts as progress: the guard compares a content-based
  fingerprint of the worktree (tracked diff plus non-empty untracked files).
  Touching a file or a `.loop-nudge` does not change it.
- **Touch-nudge evasion.** A call such as `touch X && <blocked command>` is the
  same command as the blocked one. It is denied and logged as
  `LOOP-GUARD-EVASION`.
- **Stop.** After 3 denials of one cluster (the 7th attempt) the session is
  stopped. A headless `claude -p` ignores a hook's stop request, so the hook also
  leaves a marker the runner reads and signals the worker's process; the worker
  ends failed with reason `loop-stopped` and its build tickets are released.
- **Piecewise reading.** 15 read-only Bash calls in a row with one template and
  an unchanged worktree are denied on the next call (override with the
  environment variable `PAI_LOOP_READ_STREAK`). Three such denials in a row stop
  the session. Read whole files with the Read tool instead.

A command that hung before carries a hint to fix the code at the hang location
first.

## The supervisor's repeated-failure watch

Independently, the supervising `pai worker run` scans the worker's stream for
the same failing tool call: at 3 repeats the worker is warned, at 6 a local
worker is stopped. A warned local worker is told to re-read the file or move on.

## Other guards

- **Background commands** need a pane: `run_in_background` is denied unless the
  command starts with `pai pane run` and friends (see [panes](panes.md)).
- **Long foreground waits** are denied for workers; they run jobs detached and
  wait in slices with `pai worker wait-on` (see its `--help`).
- **Time limit.** `workers.defaultMaxMinutes` (default 60; 0 = none) is the
  default limit of every run.
- **Nesting.** `workers.tree.maxDepth` (2) and `workers.tree.maxChildren` (4)
  cap sub-workers.
- **Stall.** No tool call for `workers.supervision.stallMinutes` (10) marks a
  unit stalled.

## Denials

Every hook denial of a worker is recorded: time, tool, hook, the first ~120
characters of the input and ~200 of the reason; up to 50 per run, the true total
stays in the count. A denial is flagged **spec conflict** when the same hook,
tool and reason was denied twice or more, or the denied input shares 20 or more
consecutive characters with the spec.

You see it as `denied 3` or `denied 3 spec?` in `pai worker ps` and the pane
status line, as one line per denial in `pai worker replay <id>` (`!` marks a
likely spec conflict), and in the report.

```
pai worker replay <id>
```

`denied N spec?` means the spec asked for something the contract forbids (a
heredoc, a long foreground wait): rewrite the spec. The session that started a
worker is told when denials pile up, see [notifications](notifications.md).
Details: [../worker-denials.md](../worker-denials.md).

Setting this up for the first time: [first workers](../install/first-workers.md).
