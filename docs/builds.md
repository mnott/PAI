# Builds: one machine-wide queue

Heavy builds and simulator test runs used to run in parallel from several sessions and workers (load average ~47 on an 18-core machine) and orphaned build processes outlived killed workers. PAI now runs them through one queue, and the PreToolUse guard enforces it.

## Running a build

```
pai build run [--full] [--label L] -- <command...>
```

- One lock for the whole machine. `builds.slots` in the main PAI config sets how many builds run at once (default 1). Waiting builds start FIFO.
- While waiting it prints a heartbeat every 30 s: `build queued: position 2, behind <label> from <session>, waiting 3m`.
- The child runs at low CPU priority (`taskpolicy -b` on macOS, `nice -n 10` elsewhere), in its own process group, with the output teed to `<PAI home>/logs/builds/<id>.log`.
- The whole tree dies with the caller: SIGTERM/SIGINT/SIGHUP kill the group, a reparented caller (shell gone) is detected within a second, and a detached watcher kills the tree if the gate itself is SIGKILLed. Any later queue read also prunes tickets of dead gates and kills their trees.
- A worker that is killed (`pai worker kill`, SIGTERM of its run) or loop-stopped releases its builds and its build tree is killed.

## Delta by default

The gate sets `PAI_BUILD_MODE=delta` (default) or `full` (`--full`) in the child's environment. It does not decide how to build deltas: project build scripts read the variable. Use `--full` only for a release or when asked.

## Seeing the queue

- `pai build queue`, the block `builds (1 slot)` in `pai worker ps` and in the cockpit worker panel.
- MCP: `build_queue` (`action=list`, or `action=next` with an `id` to give a waiting build the next slot; a running build is never interrupted).
- `pai build next <id>` does the same from the shell.

## Enforcement

The PreToolUse Bash guard (interactive sessions and workers) denies raw `xcodebuild`, `xcrun simctl ... (test|launch|boot)`, `swift build|test`, `gradle(w) build|test|assemble...` and `cargo build|test`, also inside `bash -c`, pipes and `&&` chains. Allowed: `pai build run ...`, `pai build lock ...` and registered doors. Informational calls (`xcodebuild -version`, `swift --version`) and mere mentions (`echo xcodebuild`) pass.

Deny message: *Builds go through the machine-wide queue: use `pai build run -- <cmd>` (or this project's door <door>); deltas by default, --full only for a release.*

## Project doors: `.pai/builds.yaml`

```yaml
doors: [tools/build.sh]      # scripts that may be called directly
patterns: ['^make ios']      # extra regexes (matched on the command) that count as heavy
```

A door is a script that wraps its real command in the same lock:

```sh
#!/bin/sh
exec pai build lock -- xcodebuild -scheme App "$@"
```

`pai build lock` is `pai build run` for door scripts; inside a `pai build run` it just runs the command, so nesting cannot deadlock. The guard cannot read a script's mind: it allows any registered door. The door owner must call `pai build lock` inside it; `pai build doctor` flags doors that are missing or never call it.
