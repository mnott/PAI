# `.pai/worker.md`: per-project worker rules

A file at the root of a project whose text every worker started there carries
in its system prompt.

## What it does

The text of `.pai/worker.md` (git toplevel of the working directory; the
directory itself outside git) is appended to the worker's system prompt right
after the worker contract, under the heading `## Project worker rules`.

- **Cache-stable.** The block is the heading plus the file text, byte for byte,
  with nothing run-specific added. All workers of a project share one prompt
  prefix, so the provider cache is reused. Keep ids, dates and paths out of the
  file, or every edit of such a value busts the cache.
- **16 KB limit.** A file over 16384 bytes is refused (never truncated): the
  worker does not start and the error names the file and size. A missing or
  empty file means no rules.
- `pai worker run` prints `preamble: .pai/worker.md (N lines)` or `preamble: none`.

## Set up for a project

```
pai project init       # writes a short generic starter if the file is missing
```

Then edit it: build and test commands, forbidden commands, commit style, where
generated files live. Short imperative lines work best; do not repeat the worker
contract.

## See it working

`pai worker run` startup line `preamble: .pai/worker.md (N lines)`;
`pai project health` line `ok - .pai/worker.md size ok`.

## Troubleshooting

- `over the 16384 byte limit`: shorten the file; move reference material into
  docs the worker can read on demand.
- Rules have no effect: the file must be at the git toplevel, not a subdirectory.
- Every worker misses the cache after an edit: expected once per edit; avoid
  frequent edits and run-specific values.
