# Issue claims

Mark the forge issue you (or a worker) are working on, so nobody else starts it.

## What it does

The claim convention is fixed: **assignee `claude` + label `in-progress`**. Other
assignees and labels are left alone. PAI never closes an issue; closing is yours.

```
pai issue claim <n>            # add assignee claude + label in-progress
pai issue release <n>          # remove both
pai issue claims               # open issues of this project carrying in-progress
pai issue stale [--days N] [--json]   # open issues that are landed or idle (default N=7)
```

`claim`/`release` take `--dry-run` (print the requests, send none). MCP:
`issue_claim`, `issue_release`, `issue_claims`, `issue_stale` (same arguments, `dry_run`).

- **Release at worker end.** A claim made inside a worker is recorded in the
  worker's status and released automatically when the worker ends, unless its
  report says `r=~` (work continues). A failed release prints `claim release failed: ...` on stderr and is
  kept in the worker's status.
- **`pai issue stale`** lists open issues that are `landed` or `idle`, so the
  operator can close them in one pass (PAI never closes anything):
  - `landed`: a branch merged into the integration branch (`develop` if it
    exists, else the default branch) has the issue number as a whole name token
    (`recovery/747`, `fix-747-x`), or a commit there says `fixes #747` /
    `closes #747` / `resolves #747`. A plain mention or a trailing `(#747)` does
    not count. Projects that delete issue branches after landing and do not use
    closing keywords will see `idle` only.
  - `idle`: no forge activity for `--days N` days.
  - The project's anchor issue (`status.forge.anchor`) is never listed.
  - With `status.sink: forge`, the daemon's daily pass writes the same list into
    the handover issue inside `<!-- pai:stale -->…<!-- /pai:stale -->`.
- If the label `in-progress` does not exist in the repo, the claim is
  assignee-only and says so.

## Set up for a project

The repo comes from `.pai/project.yaml` (`status.forge.repo`) or the `origin`
remote, and needs a forge token: see [project-status-sink.md](project-status-sink.md).
`pai project init` prepares both.

## See it working

`pai issue claim 12 --dry-run` prints `DRY RUN (nothing sent): claimed ORG/Repo#12`
and the requests it would send; `pai issue claims` lists the result.

## Troubleshooting

- `no forge token`: `pai config set forge.token <token>`.
- `no origin remote`: add one, or set `status.forge.repo`.
- `HTTP 404`: wrong issue number, or the token cannot see the repo.
