# Plan runner (`pai plan`)

A scripted runner for planned jobs: a YAML plan lists units and parts, a plain loop (no model) runs them on a local provider, merges each with a gate and keeps going when one fails.

```
pai plan validate plan.yaml     # check the file, list totals
pai plan run plan.yaml --dry-run  # print the schedule, start nothing
pai plan run plan.yaml          # run it
pai plan status plan.yaml       # done / running / waiting / needs-decision, wall time, tokens
```

## Plan file

```yaml
job: parser-rewrite            # label prefix: "<job>: <unit> <part>"
repo: .                        # git checkout (relative to the plan file)
gate: npx tsc --noEmit && npx vitest run   # run on the merged tree; failure reverts the merge
provider: local                # local provider, runs with --class implement
max_parallel: 2                # optional; default the provider's maxConcurrent (else 3)
preamble: Follow the repo conventions.     # optional text or file path, prepended to every spec
units:
  - id: parser
    preamble: notes/parser-context.md      # optional, prepended after the plan preamble
    unit_check: node scripts/parity.mjs    # optional, after the unit's last part merged
    parts:
      - id: p1
        spec: Add the tokenizer.           # text, or a path to a file holding it
        files: [src/tok.ts]                # parts sharing a file never run together
        proof: npx vitest run src/tok.test.ts
      - id: p2
        spec: specs/p2.md
        depends_on: [p1]                   # part ids, also across units
        risky: true
      - id: p3
        spec: Add the formatter.
        files: [src/fmt.ts]
        overlap: true                      # independent of p2: starts when p2's worker ended, during its gate
```

`overlap: true` (default false) is set by whoever writes the plan, for a part that does not depend (directly or through others) on the part before it. The local engine serves one worker at a time, so the runner would otherwise leave it idle while the previous part is gated and merged (about 20-35 s per part). With the flag, the part's worker starts as soon as the previous part's worker has ended; its worktree is cut from main as it is then, its merge waits until the previous part is through, and a conflict goes through the normal conflict handling. If the previous part fails its gate the overlapping part keeps running (`overlap-continue` event). Never more than `max_parallel` workers run on a provider; `validate` rejects `overlap` on a part that depends on the part before it.

`validate` rejects missing fields, duplicate ids, unknown dependencies, cycles and spec paths that name no file. The same description lives in code as `PLAN_SCHEMA` (`src/workers/plan.ts`).

## What the runner does

- Refuses to start when the repo has uncommitted changes to files a part touches (they would be clobbered or mixed in); `--allow-dirty` overrides.
- Keeps up to N parts running (`pai worker run --provider <local> --class implement`, label `"<job>: <unit> <part>"`).
- Starts a part when all its `depends_on` are merged and no running part touches one of its files (a directory in `files` covers everything below it); starts the next as soon as a slot frees.
- When a part finishes with a valid passing report it is merged with `pai worker merge <id> --verify "<gate>"`. Merges and unit checks run one at a time.
- Every composed spec ends with a fixed footer: work only with relative paths inside the current directory (the worker's own worktree), git add the files you changed, then commit on the current branch (an empty commit is not a commit) with the message `"<job>: <unit> <part>"`, report with R. Absolute paths into the repo in a spec, `files` or `proof` are rewritten to relative ones; `validate` warns about them. Workers run with `--cwd <repo> --worktree` passed explicitly (the caller's own mode is never inherited); a worker whose status shows no worktree stops its part with needs-decision, no retry. Part workers open a visible pane like any worker (no `--no-pane`; the pane policy stays). A spawn that fails before a worker exists (pane/gate/config refusal from `pai worker run`) is an environment error: the part goes to needs-decision at once with the message, no retry, and once the same refusal repeats the runner starts no further parts and prints the refusal once in the summary.
- A merge counts only when the worker branch has at least one non-empty commit (checked before `pai worker merge` is called; otherwise no merge runs) and HEAD moved. Otherwise the log records `merge` with `ok: false, status: "no-commit"` and the part goes down the failure ladder (the retry spec says why).
- Failure ladder: a failed gate or proof, a worker branch without a commit, or a worker that ends without a valid report, gets one local retry with the failure tail appended to the spec. A second failure marks the part `needs-decision`; parts that do not depend on it carry on. With `--escalate sonnet` one Sonnet implement worker runs for that part instead (counted in the summary). The runner never calls Opus.
- `unit_check` runs in the repo after the unit's last part merged; a failure marks the unit needs-decision and holds every part that depends on one of its parts.

## Idle accounting

The run log carries `worker-start` / `worker-end` per worker and a computed `model-idle` event (`ms`, `provider`, `reason`: gate, merge, unit-check or waiting-for-dependency) between one worker's end and the next worker's start on the same provider. `run-end` carries `idleMs`, `wallMs`, `overlaps`. `pai plan status`, `plan_status`, the `pai worker ps` plan line and the run-end report show "local model idle <total> of <wall> (<pct>%)" and the overlap count; the report splits tokens into `local_tokens` and `cloud_tokens` (escalation workers).

## Exit codes

- `0`: every part merged.
- `1`: failures (needs-decision parts or failed unit checks) with everything else done.
- `3`: blocked. Nothing is running and no part can start (each remaining part is needs-decision or depends on one, or a unit_check failed and the rest depends on that unit). The run ends at once, prints `blocked: <n> parts wait on needs-decision items: <list>; fix and re-run `pai plan run <plan>` (merged parts are skipped)` and logs `run-end` with status `blocked`.

## Run log and resume

Every step is appended to `<plan>.run.jsonl`: `run-start`, `part-start`, `worker-start`, `worker-end`, `model-idle`, `part-end` (worker id, attempt, tier, tokens from the worker's run log when available), `merge` (gate, commit), `escalate`, `needs-decision`, `unit-check`, `run-end`. Run the same plan again and merged parts and passed unit checks are skipped; needs-decision parts are tried again.

The exit code is 0 only when every part merged and every unit check passed.

## Detached runs and events

`pai plan run PLAN --detach` hands the run to a detached process (the same command line without `--detach`) and returns at once; the run keeps going when the starting session ends. It is registered as `<logDir>/runs/plan-<job>-<stamp>.json` (pid, argv, originating session, output file `.out`). The originating session is `CLAUDE_CODE_SESSION_ID` / the iTerm2 session / `PAI_SESSION_NAME`, passed to the child as `PAI_RUN_ORIGIN`. The daemon checks the registry on its supervision tick: a run whose process is gone without having finished is reported once as `run-died`.

A run (detached or not) that has an originating session reports back, so the operator never has to poll:

- to the session, through AIBroker `send_to_session` (the session wakes and can talk to the operator): one line, `S i=plan:<job> z=<kind> | k=v ... — <plain sentence>`, kinds `needs-decision` (a part failed twice), `unit-check-failed`, `unit-done` (at most one message per 15 minutes; units finished in between are listed together) and `run-merged` / `run-blocked` / `run-failed` (wall time, parts merged, escalations, cloud tokens);
- to PAILot (`pailot_send`, one plain sentence) for the run end only: finished, blocked or failed.

If AIBroker is not reachable the failure is logged to stderr and the run continues. The run log gains a `unit-done` entry for every unit whose parts are merged (and, if it has one, whose check passed).
