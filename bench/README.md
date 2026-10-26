# bench: local-model quality check

The model-eval harness behind `pai bench`. Drive it with the command; the scripts also run by hand.

```
pai bench run --provider gyro-m --sets short,easy,hard --reps 3 --real 2 --key gyro-m
pai bench table --keys gyro-m,gyro-l:gyro-coder-l --ref sonnet:anthropic
```

Results and worker logs go to `$PAI_BENCH_DIR` (default `~/.cache/pai/bench`: `results/<set>/<key>/rep<k>.json`, `work/`, `progress.md`, `series-<key>.log`), never into the repo. Do not start or stop model servers from here: the provider's server must already be running; runs are serial because one engine serves one model at a time.

## Pieces

| file | what |
|---|---|
| `evalset.sh <provider> <model\|default\|-> <short\|easy\|hard> <rep> [key]` | one agent run, graded by the harness |
| `realset.sh <provider> <model\|default\|-> <rep> [key]` | the 5 real PAI tasks in `tasks/`: throwaway clones of this repo at the parent of the fix commit, hidden tests judge |
| `evalset.py` | prep (task file without tests or answers) and grading (`codeeval.py`: sandboxed, 10 s timeout, network denied; regex check for the short set) |
| `data/` | the task sets: `codeeval-tasks.jsonl` (easy), `codeeval-hard.jsonl`, `cascade-tasks.jsonl` (short) |
| `tasks/<name>/` | real task: `spec.md` (what the worker is told), `meta.env` (`FIX` commit, hidden `TESTS`) |
| `config-eval.template.yaml` | per-run config copy: `pai_eval` database (never the live one), panes not required, routing pinned to `__PROVIDER__`, escalation off, `retryOnQuota` off |
| `summarize.py` | `summary.json` / `summary.md` (mean, sd, min, max per model and set) over the results dir |
| `lib.sh`, `instrument.sh` | clone and test helpers; PAI's own malformed-tool-call classification |

`pai bench run` adds what the scripts do not do themselves:

- **Watchdog**: it follows the worker transcripts and stops the series, logging the reason in `series-<key>.log`, on `REWRITE` (an answer file written 4 times), `RUNAWAY` (more than 60 distinct answer files in one run) or `IDLE` (no worker activity for `--idle` seconds, default 90).
- **Real-task cap**: `--real-cap` minutes per real task (default 30), passed to `pai worker run --max-minutes`.
- **Power gate**: `pai power wait` between runs when that command exists, else no gate.

## How an agent run works

The worker runs in `work/<set>/<key>/rep<k>/` (`--no-worktree --cwd .`, tools `Read,Write` only) with a spec: solve every task in `tasks.jsonl` (id, prompt, entry; no tests), write only the solution to `out/<id>.py` (short set: the exact answer to `out/<id>.txt`). Afterwards the harness grades `out/` itself. The run JSON carries `pass_at_1`, `wall_s`, tokens, `tok_per_s`, and `status` (`error` when the worker failed). Real set: `pass_at_1` is tasks passed over 5; the hidden tests are checked out over the worker's tree after it ends.

## Counting rules of `pai bench table`

- A run counts only if its route line, its ending provider and its single worker id all name the model (no silent fallback to a cloud model).
- A loop-stopped or killed run counts for pass %, not for time or tok/s.
- Real tasks over 900 s are left out of s/task; their pass/fail still counts. A real rep with a task on another provider is left out entirely.
- `--ref KEY[:PROVIDER]` adds cloud reference rows from results of the same layout (produce them with `pai bench run --provider anthropic --key sonnet`).

## Adding a real task

Create `tasks/<name>/spec.md` and `meta.env` with `FIX=<commit that fixed it>` and `TESTS="<test files>"`, and add the name to `TASKS` in `lib.sh`. The task starts at `FIX^`; the tests of `FIX` judge.
