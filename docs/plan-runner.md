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
```

`validate` rejects missing fields, duplicate ids, unknown dependencies, cycles and spec paths that name no file. The same description lives in code as `PLAN_SCHEMA` (`src/workers/plan.ts`).

## What the runner does

- Refuses to start when the repo has uncommitted changes to files a part touches (they would be clobbered or mixed in); `--allow-dirty` overrides.
- Keeps up to N parts running (`pai worker run --provider <local> --class implement`, label `"<job>: <unit> <part>"`).
- Starts a part when all its `depends_on` are merged and no running part touches one of its files (a directory in `files` covers everything below it); starts the next as soon as a slot frees.
- When a part finishes with a valid passing report it is merged with `pai worker merge <id> --verify "<gate>"`. Merges and unit checks run one at a time.
- Every composed spec ends with a fixed footer: work only with relative paths inside the current directory (the worker's own worktree), commit on the current branch with the message `"<job>: <unit> <part>"`, report with R. Absolute paths into the repo in a spec, `files` or `proof` are rewritten to relative ones; `validate` warns about them. Workers run with `--cwd <repo>` and the default worktree (never `--no-worktree`).
- A merge counts only when the worker branch has at least one commit and HEAD moved. Otherwise the log records `merge` with `ok: false, status: "no-commit"` and the part goes down the failure ladder (the retry spec says why).
- Failure ladder: a failed gate or proof, a worker branch without a commit, or a worker that ends without a valid report, gets one local retry with the failure tail appended to the spec. A second failure marks the part `needs-decision`; parts that do not depend on it carry on. With `--escalate sonnet` one Sonnet implement worker runs for that part instead (counted in the summary). The runner never calls Opus.
- `unit_check` runs in the repo after the unit's last part merged; a failure marks the unit needs-decision.

## Run log and resume

Every step is appended to `<plan>.run.jsonl`: `run-start`, `part-start`, `part-end` (worker id, attempt, tier, tokens from the worker's run log when available), `merge` (gate, commit), `escalate`, `needs-decision`, `unit-check`, `run-end`. Run the same plan again and merged parts and passed unit checks are skipped; needs-decision parts are tried again.

The exit code is 0 only when every part merged and every unit check passed.
