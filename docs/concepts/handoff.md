# Handoff

## What it is

A handoff is a short Markdown brief of one session: the user requests, files changed, recent commands and where the work stopped. You give it to another session, provider or worker so it can continue without the full transcript.

The brief is bounded to 48 KB, secrets are replaced with `[REDACTED]`, and the file is written with mode 0600 under `<PAI home>/handoffs`. Only its path goes on the command line, never its content.

## When to use it

- You switch provider or harness in the middle of a task.
- You hand a half-done job to a worker.
- A session grew too large and you want a clean start that still knows the state.

## Commands

```
pai handoff export [SESSION]
pai handoff show PATH
pai git setup
pai git notes [REV]
```

- `export` takes a session id or transcript path. Without one it uses the newest transcript of the current directory. It prints the brief's path and a line to continue with.
- `show` prints a brief written by `export`.
- The continue line contains a `[pai-handoff from=<id>]` marker. When the next session's first prompt has it, PAI records the link between the two sessions.

### Git notes

`pai git setup` writes a `post-commit` hook in the repository. It stores a git note in `refs/notes/pai` naming the session and worker that edited the files of each commit. An existing `post-commit` hook is kept as `post-commit.pre-pai` and called first. The hook runs in the background with a short time budget, so commits are not slowed. Notes follow amends and rebases (`notes.rewriteRef` is set).

`pai git notes [REV]` prints the session and worker recorded for a commit (default `HEAD`), or `no PAI note`.

## Config keys

None. Handoff and git notes have no settings.

## Worked example

1. In the project, run `pai handoff export`. Output:

   ```
   <PAI home>/handoffs/<session>-<date>.md
   Continue with: claude "Read <path> and continue. [pai-handoff from=<session>]"
   ```

2. Run the `claude` line in a new session, or give the path to a worker.
3. Later, `pai git notes HEAD` on a commit made there shows the session and worker behind it.

## Related

- [Session management](../session-management.md), [session notes](../session-notes.md)
- [`pai handoff`](../commands/handoff.md), [`pai git`](../commands/git.md)
