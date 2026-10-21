---
name: setup
description: >
  Install, configure and verify PAI Knowledge OS, including workers, the router and the cockpit.
  USE WHEN user says "set up PAI", "install PAI", "configure PAI", "give Claude a memory",
  "set up workers", "set up the cockpit", or asks whether their PAI install is healthy.
  Phase-based and idempotent: every phase checks its state first and only does what is missing.
---

# PAI setup

Work through the phases in order. Run the check of a phase first; if it already passes, say so and move on. Prefer `pai` commands over editing files by hand; `pai <command> --help` is the reference. Ask the user before anything that installs a service, needs an API key, or starts a large download. Never print API keys back.

## 1. Prerequisites

Check: `node --version` (needs 20 or newer), `claude --version`, `git --version`.

- Node missing or older than 20: install a current LTS (brew, nvm, or the system package manager). Bun is not needed to install or run PAI.
- Claude Code missing: install it from its official installer, then run `claude` once to log in.
- On a clean macOS, `git` can be a stub that fails until the Xcode command line tools are installed; trust `git --version`, not `command -v git`.
- Linux: also install `tmux` (worker panes). Use an npm prefix in the home directory so `npm i -g` needs no sudo: `npm config set prefix ~/.npm-global` and put `~/.npm-global/bin` on PATH.

Verify: all three commands print a version. If `npm i -g` later fails with EACCES, fix the prefix as above.

## 2. Install or upgrade the package

Check: `pai --version`.

```
npm i -g @tekmidian/pai          # install
npm i -g @tekmidian/pai@latest   # upgrade
```

Verify: `pai --version` prints a version and `pai more` lists commands. If `pai` is not found, put the npm global bin directory (`npm prefix -g`, then `/bin`) on PATH and open a new shell.

## 3. Run setup

```
pai setup            # interactive
pai setup --yes --storage sqlite
```

Setup covers storage, search embeddings, Claude Code hooks and settings, the background daemon and the first index. It is safe to run again. `--yes` takes every default; without `--storage` it picks sqlite unless a local Postgres answers.

Storage choice, ask the user:
- **sqlite**: keyword search, no extra software. Right for most people and for small machines.
- **postgres**: keyword plus semantic search. Needs Docker; setup starts a `pai-pgvector` container itself. On a small machine export `PAI_PG_SHARED_BUFFERS=256MB` first.

Verify: setup ends without an error and `pai memory search "test"` runs (it finds results once the first index is done). If it stops, fix the named cause and run `pai setup` again.

## 4. Daemon

Check: `pai daemon status` says running. Under a HOME that is not the account home (a sandbox or test), setup writes the service file but does not load it: the status stays "not running" and the command to load it is printed.

Setup installs the daemon as a login service (launchd on macOS, a systemd user unit on Linux). If it is not running:

```
pai daemon install     # re-create the service
pai daemon restart
```

On Linux without systemd (containers) run `pai daemon serve` in a terminal or process manager instead. If it still fails, read `pai daemon logs`.

## 5. Workers: first provider

Workers are Claude Code runs on a provider you choose. Setup turns them on with the built-in `anthropic` provider.

Check: `pai worker providers` lists at least one provider.

To add a second provider (cheaper or faster), ask the user for its Anthropic-compatible base URL, model id and a key file. Put the key in a file the user creates, do not paste it into the command line history if avoidable:

```
pai worker providers add NAME --url URL --model MODEL --key-file PATH
pai worker providers test NAME
pai worker config check
```

`pai worker providers use NAME` makes it the active one. A provider with an OpenAI-style API takes `--protocol openai --upstream-url URL` instead of `--url`.

Verify: `pai worker providers test` (no name: it tests what routing would use for a worker now) prints a reply, and `pai worker config check` exits 0. If the test fails, check the key file and URL with the user; `pai worker providers disable NAME` takes a broken provider out of routing.

## 6. Delegation table

```
pai worker route
```

One row per tier, each an ordered list of models: the first available one serves, the rest is the fallback order.
- **t0 Session**: the interactive session itself. **t1 Orchestrator**: splits a job, plans, reviews. **t2 Worker**: implements the parts and runs quick checks.
- A local model appears as an entry like any other and is skipped when its server is not running. Change a row with `pai worker route set t2 anthropic/sonnet,glm/MODEL`.

`pai worker policy` shows (and sets) whether work prefers local or cloud models: `cloud-only`, `local-only`, `prefer-local`, `prefer-cloud`, `auto`, `clear`.

Verify: the table shows a model you have access to on every row. If a row names a provider you do not use, fix it with `route set`.

## 7. Router and cockpit

The router is off by default. It gives usage accounting, the local-model scheduler and the cockpit page.

```
pai config set router.enabled true
pai reload
pai router status
```

Then open `http://127.0.0.1:8790/cockpit` in a browser.

Verify: `pai router status` says running and the page loads. If not, `pai router start`, then check that nothing else uses port 8790.

## 8. Optional: a local model

Only if the user has a local engine and a model (Apple silicon with vllm-mlx, llama-server, ollama, Strata). Local models are declared under `local_tiers:` in the file `pai worker config path` prints; the shape is in `docs/concepts/local-models.md`.

```
pai models                      # what runs on this machine
pai worker local status
pai worker local TIER --dry-run # shows the exact commands, starts nothing
pai worker local TIER           # after the user agrees
```

Verify: `pai worker local` prints the running model and `pai worker route` shows it in a row. `pai worker local` does not change routing; set that with `pai worker policy prefer-local`.

## 9. After any update

```
npm i -g @tekmidian/pai@latest
pai reload
```

`pai reload` restarts the daemon, the router and the worker pool host onto the new code and prints one line per process.

## 10. Final verification

Report each line as pass or fail with the command output:

1. `node --version` is 20 or newer; `claude --version` works
2. `pai --version` works
3. `pai daemon status` says running
4. `pai memory search "test"` runs without error
5. `pai worker providers test` answers: without a name it tests the provider routing would use now, and `pai worker providers test anthropic` probes the local `claude` CLI (installed, logged in — no API key involved)
6. `pai worker config check` exits 0
7. `pai worker route` shows a model on every tier
8. `pai router status` running and the cockpit page loads (if phase 7 was done)
9. `pai` opens the session picker (Esc quits)

Details: `docs/install/index.md`, `docs/install/first-workers.md`.
