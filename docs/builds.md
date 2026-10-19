# Builds: one machine-wide queue

Heavy builds and simulator test runs used to run in parallel from several sessions and workers (load average ~47 on an 18-core machine) and orphaned build processes outlived killed workers. PAI now runs them through one queue, and the PreToolUse guard enforces it.

## Running a build

```
pai build run [--full] [--label L] [--kind build|test] -- <command...>
```

- One lock for the whole machine. `builds.slots` in the main PAI config sets how many builds run at once (default 1). Waiting builds start FIFO.
- Simulator/device test runs are a separate pool: `builds.testSlots` (default 2), taken with `--kind test`. Compiling and testing no longer wait on each other; tests wait only for other tests. `PAI_BUILD_SLOTS` / `PAI_TEST_SLOTS` override the config for one process.
- While waiting it prints a heartbeat every 30 s: `build queued: position 2, behind <label> from <session>, waiting 3m`.
- The child runs at low CPU priority (`taskpolicy -b` on macOS, `nice -n 10` elsewhere), in its own process group, with the output teed to `<PAI home>/logs/builds/<id>.log`.
- The whole tree dies with the caller: SIGTERM/SIGINT/SIGHUP kill the group, a reparented caller (shell gone) is detected within a second, and a detached watcher kills the tree if the gate itself is SIGKILLed. Any later queue read also prunes tickets of dead gates and kills their trees.
- A worker that is killed (`pai worker kill`, SIGTERM of its run) or loop-stopped releases its builds and its build tree is killed.

## Test jobs and simulators

`pai build run --kind test -- <cmd>` (and `pai build lock --kind test`) takes a test slot. The gate records which simulators are booted when the job starts; when it ends (normal exit, killed, caller died) it runs `xcrun simctl shutdown <udid>` for the ones the job added, so idle simulators do not keep burning CPU. Simulators that were already up are left alone. If the gate itself is SIGKILLed, the detached watcher does the same cleanup.

## Delta by default

The gate sets `PAI_BUILD_MODE=delta` (default) or `full` (`--full`) in the child's environment. It does not decide how to build deltas: project build scripts read the variable. Use `--full` only for a release or when asked.

## Seeing the queue

- `pai build queue`, the blocks `builds (3 slots)` and `tests (2 slots)` in `pai worker ps` and in the cockpit worker panel.
- MCP: `build_queue` (`action=list`, or `action=next` with an `id` to give a waiting build the next slot; a running build is never interrupted).
- `pai build next <id>` does the same from the shell.

## Enforcement

The PreToolUse Bash guard (interactive sessions and workers) denies raw `xcodebuild`, `xcrun simctl ... (test|launch|boot)`, `swift build|test`, `gradle(w) build|test|assemble...` and `cargo build|test`, also inside `bash -c`, pipes and `&&` chains. Allowed: `pai build run ...`, `pai build lock ...` and registered doors. Informational calls (`xcodebuild -version`, `swift --version`) and mere mentions (`echo xcodebuild`) pass.

The guard classifies each heavy command: raw `xcrun simctl ... (boot|launch|test)` and `xcodebuild test|test-without-building` are kind `test`, everything else heavy is kind `build`. The deny message names the kind and, for tests, suggests `pai build run --kind test -- <cmd>`. Doors pass `--kind` to `pai build lock` themselves.

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
