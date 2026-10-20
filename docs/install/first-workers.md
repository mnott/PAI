# First workers

After [install](index.md), PAI can hand work to workers: Claude Code runs on a provider you choose, while your own session keeps going. Setup turns workers on with the built-in `anthropic` provider, so this works before you add anything.

## 1. The first provider

```bash
pai worker providers            # what exists, which models, whether workers are on
```

To add a second provider (cheaper, faster, or another vendor) you need its Anthropic-compatible base URL, a model id, and a key in a private file:

```bash
pai worker providers add NAME --url URL --model MODEL --fast-model FAST --key-file PATH
pai worker providers test NAME  # sends one word, prints the reply and the time
pai worker config check         # validates workers.yaml, names file and line on error
```

OpenAI-style APIs use `--protocol openai --upstream-url URL`. `pai worker providers use NAME` makes it the active provider (where `pai new` starts and where new workers go by default); `disable NAME` takes it out of automatic routing. The file is `pai worker config path`.

If the test fails: check the key file and URL, then `pai worker providers disable NAME` until fixed.

## 2. Check the delegation table

```bash
pai worker route
pai worker policy
```

`route` prints one row per tier of `tiers:` in workers.yaml; each row is an ordered list of models, the first available one serves and the rest is the fallback order.

- t0 Session is the interactive session; t1 Orchestrator splits and reviews; t2 Worker implements and runs quick checks.
- A local model is an entry like any other and is skipped when its server is not running, never started by routing.

Change a row: `pai worker route set t2 anthropic/sonnet,glm/MODEL --note "why"`. For one session only: add `--session self` (undo with `route clear --session self t2`).

`policy` shows the mode and the route the next run would take: `cloud-only`, `local-only`, `prefer-local`, `prefer-cloud`, `auto` (prefer-local, but cloud on battery and for `--urgent` runs), or `clear`. A time limit: `pai worker policy prefer-local --for 2h`.

Sanity check: every row names a model you can actually use. A failure here means a row points at a provider you removed or never added; fix it with `route set`.

## 3. Router and cockpit

The router is a local service on 127.0.0.1:8790. It is off by default. It records usage per provider, schedules local engines and serves the cockpit. See [Router](../concepts/router.md).

```bash
pai config set router.enabled true
pai reload
pai router status
```

Open `http://127.0.0.1:8790/cockpit`. If the page does not load, `pai router start`, and check that no other program holds port 8790. `pai router stats --since 1d` shows the token totals once workers have run.

## 4. Optional: a local model

Needs an engine on the machine (vllm-mlx, llama-server, ollama, Strata) and a model. Declare it under `local_tiers:` in workers.yaml; the shape is in [Local models](../concepts/local-models.md).

```bash
pai models                         # runtimes and models running now
pai worker local status
pai worker local TIER --dry-run    # prints the exact commands, changes nothing
pai worker local TIER              # stops other local servers, starts this tier
pai worker policy prefer-local
```

`pai worker local TIER` does not change routing; the policy does. PAI keeps one coding model in memory at a time. Check with `pai worker local` (one line with the running model) and `pai worker route` (the model shows in a row).

## 5. Run one

```bash
pai worker run --spec FILE         # or -p 'task'; add --local for the running local model
```

Related: [Panes](../concepts/panes.md) (where a worker's output shows), [Worker pool](../concepts/pool.md) (warm spares), [Loop guard and limits](../concepts/loop-guard-and-limits.md), [Notifications](../concepts/notifications.md) (what reaches your phone).
