# First workers

After [install](index.md), PAI can hand work to workers: background Claude Code runs, on a provider you choose, while your own session keeps going. Workers are optional; memory works without them. Terms (provider, tier, class, pane, salvage) are in the [glossary](../README.md#words-used-in-these-docs).

The built-in `anthropic` provider uses your existing Claude Code login; there is no key to add. Setup turns workers on with it, so this works before you add anything. Workers config lives in `workers.yaml` inside the [PAI home](../README.md#words-used-in-these-docs); `pai worker config path` prints its location.

## 1. Run one

```bash
pai worker providers test anthropic     # prints the reply and a time such as 1.2s
pai worker run -p 'say hello' --class simple
pai worker ps                           # the worker shows as finished
```

`pai worker run` waits for the worker and prints its final report (a short key=value block; `r=+` means done and verified). In tmux or iTerm2 a pane opens next to your session and shows the worker live; without either, PAI prints a `pai worker follow ID` command to watch it. See [Panes](../concepts/panes.md). For longer tasks use `--spec FILE` instead of `-p`; add `--local` to use the running local model.

## 2. The providers

```bash
pai worker providers            # lists each provider; look for "anthropic [built-in]" and the enabled/active flags
```

Optional: to add a second provider (cheaper, faster, or another vendor) you need its Anthropic-compatible base URL, a model id, and a key in a private file. `--fast-model` names the cheaper model used for quick checks and routing.

```bash
pai worker providers add NAME --url URL --model MODEL --fast-model FAST --key-file PATH
pai worker providers test NAME  # sends one word; prints the reply and the time
pai worker config check         # validates workers.yaml, names file and line on error
```

`pai worker providers test` without a NAME tests what routing would use for a worker now (the t2 row's first available entry, else the active provider). `pai worker providers test anthropic` checks the built-in provider: the local `claude` CLI is installed and logged in; no API key is sent or needed.

OpenAI-style APIs use `--protocol openai --upstream-url URL`. `pai worker providers use NAME` makes it the active provider (where new sessions start and where new workers go by default); `disable NAME` takes it out of automatic routing.

If the test fails: check the key file and URL, then `pai worker providers disable NAME` until fixed; for `anthropic`, run `claude` once and log in.

## 3. Check the delegation table

```bash
pai worker route
pai worker policy
```

`route` prints one row per tier of `tiers:` in workers.yaml; each row is an ordered list of models, the first available one serves and the rest is the fallback order. You normally leave the table alone. If every row shows a model you can use, go on.

- t0 Session is the interactive session; t1 Orchestrator splits and reviews (PAI starts it for you with `--orchestrate`; you rarely touch it); t2 Worker implements and runs quick checks.
- A local model is an entry like any other and is skipped when its server is not running, never started by routing.

**`route set` replaces the whole row.** The shipped t2 row is `local, anthropic/sonnet, glm/glm-5.3-flash`, so to change only the cloud part keep `local` first:

```bash
pai worker route set t2 local,anthropic/sonnet --note "why"
```

For one session only add `--session self` (undo with `route clear --session self t2`). A failure in the table means a row points at a provider you removed or never added; fix it with `route set`. The modes of `pai worker policy` (`cloud-only`, `prefer-local`, `auto`, ...) are in [Routing policy](../concepts/routing-policy.md).

## 4. Optional: router and cockpit

Skip this unless you want the cockpit. The router is a local service on 127.0.0.1:8790. It is off by default. It records token usage per provider (what each provider's models consumed), schedules local engines and serves the cockpit. See [Router](../concepts/router.md).

```bash
pai config set router.enabled true
pai reload
pai router status
```

Open `http://127.0.0.1:8790/cockpit`. If the page does not load, `pai router start`, and check that no other program holds port 8790. `pai router stats --since 1d` shows the token totals once workers have run.

## 5. Optional: a local model

**`pai worker local TIER` stops any local model server that is running** and starts the one for that tier. Needs an engine on the machine (vllm-mlx, llama-server, ollama, or [Strata](../concepts/local-models.md)) and a model. Declare it under `local_tiers:` in workers.yaml; the shape is in [Local models](../concepts/local-models.md).

```bash
pai models                         # runtimes and models running now
pai worker local status
pai worker local TIER --dry-run    # prints the exact commands, changes nothing
pai worker local TIER              # stops other local servers, starts this tier
pai worker policy prefer-local
```

`pai worker local TIER` does not change routing; the policy does. PAI keeps one coding model in memory at a time. Check with `pai worker local` (one line with the running model) and `pai worker route` (the model shows in a row).

Related: [Panes](../concepts/panes.md) (where a worker's output shows), [Worker pool](../concepts/pool.md) (warm spares), [Loop guard and limits](../concepts/loop-guard-and-limits.md), [Notifications](../concepts/notifications.md) (what reaches your phone).
