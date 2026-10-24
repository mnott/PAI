---
name: setup
description: >
  Install, configure and verify PAI Knowledge OS, including workers, the router and the cockpit.
  USE WHEN user says "set up PAI", "install PAI", "configure PAI", "give Claude a memory",
  "set up workers", "set up the cockpit", or asks whether their PAI install is healthy.
  Phase-based and idempotent: every phase checks its state first and only does what is missing.
---

# PAI setup

Work through the phases in order. Run the check of a phase first; if it already passes, say so and move on.

**One install route, however the user started.** Whether they said "clone https://github.com/mnott/PAI and set it up for me", installed the plugin, or asked from scratch, install the same way: the released npm package (phase 2), the `pai` plugin from the marketplace (phase 2a), then `pai setup` (phase 3), which also installs AIBroker. A clone of the repository is only where these instructions came from: do not build, link or run PAI from it (that would run unreleased code). Tell the user they can delete the clone afterwards, or keep it if they want to work on PAI itself. Prefer `pai` commands over editing files by hand; `pai <command> --help` is the reference. Ask the user before anything that installs a service, needs an API key, or starts a large download — except AIBroker, which setup installs without asking because PAI's messaging depends on it. Never print API keys back.

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
npm i -g https://github.com/<owner>/<repo>/releases/latest/download/pai.tgz   # install (the release asset; no npm registry)
pai update                                  # upgrade to the latest GitHub Release
pai update --check                          # only report
```

Verify: `pai --version` prints a version and `pai more` lists commands. If `pai` is not found, add `$(npm prefix -g)/bin` to PATH in the shell profile and open a new shell.

## 2a. Install the plugin

Check: `claude plugin list` shows `pai`.

```
claude plugin marketplace add mnott/PAI
claude plugin install pai@pai
```

The plugin brings PAI's skills (this one included) and keeps them current with `claude plugin update pai`. Tell the user the plugin is active from the next Claude Code session on.

## 3. Run setup

Never run the interactive `pai setup` from a Bash tool: there is no terminal, so it cannot be answered. Ask the user in chat instead:

```
pai setup --questions --json
```

It prints every question setup would ask on this machine, in order, each with `id`, `step`, `question`, `flag`, `default`, `allowed` and, where the machine already has an answer (storage, embedding, router), `current`. Ask the user those questions in chat, grouped by `step`, with each default pre-filled; accept "defaults" for all of them, and skip questions that have a `current` value unless the user wants to change it. Then run setup once with the matching flags (omit a flag to take its default):

```
pai setup --yes --storage sqlite --embedding none --router-port 9000 --router-bind loopback --no-hooks
```

Tell the user that setup also installs the background daemon as a login service (launchd on macOS, a systemd user unit on Linux) and AIBroker, and that the cockpit is reachable from other devices when its reach is not `loopback`. Setup covers storage, search embeddings, Claude Code hooks and settings, the background daemon, the router and cockpit, and the first index. It is safe to run again. Without `--storage`, `--yes` picks sqlite unless a local Postgres answers.

Storage choice, ask the user:
- **sqlite**: keyword search, no extra software. Right for most people and for small machines.
- **postgres**: keyword plus semantic search. Needs Docker; setup starts a `pai-pgvector` container itself (or pass `--pg-url`). On a small machine export `PAI_PG_SHARED_BUFFERS=256MB` first.

Verify: setup ends without an error and `pai memory search "test"` runs (it prints hits or no results, but no error; results appear once the first index is done). If it stops, fix the named cause and run `pai setup` again.

## 4. Daemon

Check: `pai daemon status` says running. Under a HOME that is not the account home (a sandbox or test), setup writes the service file but does not load it: the status stays "not running" and the command to load it is printed.

Setup installs the daemon as a login service (launchd on macOS, a systemd user unit on Linux). If it is not running:

```
pai daemon install     # re-create the service
pai daemon restart
```

On Linux without systemd (containers) run `pai daemon serve` in a terminal or process manager instead. If it still fails, read `pai daemon logs`.

## 4a. AIBroker (messaging)

Check: `aibroker doctor` exits 0. AIBroker is a separate package and PAI's messaging layer (messages between sessions, worker reports, terminal tab names, WhatsApp, Telegram, PAILot). `pai setup` installs it automatically (unless run with `--no-aibroker`); this phase only confirms it. If `aibroker` is not on the PATH or doctor fails:

```
npm i -g https://github.com/<owner>/<aibroker-repo>/releases/latest/download/aibroker.tgz
aibroker setup      # service, MCP registration, Claude Code hooks
aibroker doctor
```

## 5. Workers: first provider

Workers are Claude Code runs on a provider you choose. Setup turns them on with the built-in `anthropic` provider.

Check: `pai worker providers` lists `anthropic [built-in]`. It uses the user's own Claude Code login, so there is no key to add.

To add a second provider (cheaper or faster), ask the user for its Anthropic-compatible base URL, model id and a key file. Put the key in a file the user creates, do not paste it into the command line history if avoidable:

```
pai worker providers add NAME --url URL --model MODEL --key-file PATH
pai worker providers test NAME
pai worker config check
```

`pai worker providers use NAME` makes it the active one. A provider with an OpenAI-style API takes `--protocol openai --upstream-url URL` instead of `--url`.

Verify: `pai worker providers test` (no name: it tests what routing would use for a worker now) prints a reply, and `pai worker config check` exits 0. If the test fails, check the key file and URL with the user; `pai worker providers disable NAME` takes a broken provider out of routing.

## 6. Delegation table

The user normally leaves this table alone; check only that it shows models they can use.

```
pai worker route
```

One row per tier, each an ordered list of models: the first available one serves, the rest is the fallback order.
- **t0 Session**: the interactive session itself. **t1 Orchestrator**: splits a job, plans, reviews. **t2 Worker**: implements the parts and runs quick checks.
- A local model appears as an entry like any other and is skipped when its server is not running. `route set` replaces the whole row and the shipped t2 row starts with `local`, so keep it first: `pai worker route set t2 local,anthropic/sonnet`.

`pai worker policy` shows (and sets) whether work prefers local or cloud models: `cloud-only`, `local-only`, `prefer-local`, `prefer-cloud`, `auto`, `clear`.

Verify: the table shows a model you have access to on every row. If a row names a provider you do not use, fix it with `route set`.

## 7. Optional: router and cockpit

The router and cockpit are asked in phase 3 (`router`, `router-port`, `router-bind` in `pai setup --questions`; flags `--router`/`--no-router`, `--router-port`, `--router-bind`), so this phase only confirms them, or changes them later. Default port 8790, reach `loopback`; `tailscale` or an address makes the cockpit reachable from other devices, so say so before choosing it. It gives usage accounting, the local-model scheduler and the cockpit page.

```
pai config set router.enabled true    # only if phase 3 left it off
pai config set router.port 9000       # only to change the port
pai reload
pai router status
```

Then open `http://127.0.0.1:<port>/cockpit` (8790 unless changed) in a browser.

Verify: `pai router status` says running and the page loads. If not, `pai router start`, then check that nothing else uses port 8790.

## 8. Optional: a local model

Only if the user has a local engine and a model (Apple silicon with vllm-mlx, llama-server, ollama, or Strata, a third-party local model server; see `docs/concepts/local-models.md`). Local models are declared under `local_tiers:` in the file `pai worker config path` prints (`workers.yaml` in the PAI home, `~/.pai` or `~/.claude/pai` on older installs).

```
pai models                      # what runs on this machine
pai worker local status
pai worker local TIER --dry-run # shows the exact commands, starts nothing
pai worker local TIER           # after the user agrees
```

Verify: `pai worker local` prints the running model and `pai worker route` shows it in a row. `pai worker local` does not change routing; set that with `pai worker policy prefer-local`.

## 9. After any update

```
pai update
pai reload
```

`pai reload` restarts the daemon, the router and the worker pool host onto the new code and prints one line per process.

## 10. Final verification

Report each line as pass or fail with the command output:

1. `node --version` prints v20 or newer; `claude --version` prints a version
2. `pai --version` prints a version; `claude plugin list` shows `pai`
3. `pai daemon status` prints `Daemon running`
4. `pai memory search "test"` ends without error
5. `pai worker providers test` prints a reply and a time (`pai worker providers test anthropic` probes the local `claude` CLI; no key involved)
6. `pai worker config check` exits 0
7. `pai worker route` shows a model on every tier
8. Only if phase 7 was done: `pai router status` says running and the cockpit page loads
9. `pai` opens the session picker (Esc quits)
10. `aibroker doctor` exits 0

Details: `docs/install/index.md`, `docs/install/first-workers.md`.
