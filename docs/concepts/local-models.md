# Local models

A local model is served by an engine on your machine and reached through a
worker provider on a loopback URL. PAI keeps **one coding model in memory at a
time**: switching starts the new one only after stopping the old one.

## Local tiers

A local tier is a named, ready-to-start model. Tiers live under `local_tiers:`
in `workers.yaml` (user file; `pai worker config path` prints it). Each tier
names a worker provider, so its port and served model name default to that
provider's `url` and `model`.

```yaml
local_tiers:
  small:
    provider: ornith            # a provider in workers.yaml
    model: /models/ornith-4bit  # engine vllm-mlx (the default): model path
    served: ornith-1.5-35b      # optional: defaults to the provider's model
    port: 8013                  # optional: derived from the provider's url
    memoryGb: 24                # optional: shown on the cockpit button
  big:
    provider: local
    engine: strata
    config: ~/strata/big.json   # required for strata
  custom:
    provider: scripted
    engine: script
    start: ~/bin/start-model.sh # required for script, run detached
```

Fields verified in `src/workers/local-tiers.ts`: `provider` (required), `engine`
(`vllm-mlx` default, `strata`, `script`), `model` (required for vllm-mlx),
`served`, `port`, `label`, `memoryGb`, `flags`, and for strata `config` and
`python`. Shared start flags come from `local_launcher:`.

## Switching

```
pai worker local               # one line: the running local model
pai worker local status        # what is up
pai worker local big --dry-run # print the exact commands, change nothing
pai worker local big           # stop every local server, start the tier
pai worker local off           # stop all
```

Switching stops every local server (vllm-mlx, Strata, scripts), starts the tier
and points `local:` in `workers.yaml` at it. It does **not** change where
workers are routed; that is `pai worker policy` and `pai worker route`.

## Other runtimes: `pai models`

`pai models` prints one table of what runs on the machine: runtime, status,
model, kind, memory, who uses it, port. It covers the loopback worker providers
(Strata, vllm-mlx, llama-server), ollama and Docker Model Runner. It is
read-only and loads nothing. It reads the daemon's 30-second cache; `--fresh`
probes now, `--json` prints JSON.

Runtimes that are not coding tiers (an embedding model, say) are started and
stopped with configured commands, under `models.runtimes` in `config.yaml`:

```yaml
models:
  runtimes:
    ollama:
      start: ollama serve
      stop: pkill ollama
      ready: http://127.0.0.1:11434/api/tags   # 2xx, or a command exiting 0
      note: free text shown on the runtime chip
```

The shipped defaults already configure `ollama` and `docker-model-runner`
(`src/config/defaults/config.yaml`); your entries win per key and nothing is
written into your file. `note` shows as the cockpit's runtime-chip title
(`ollama :11434`), never as a line on a consumer's card.

```
pai models start ollama
pai models stop docker-model-runner --model e5
```

Output goes to `<PAI home>/logs/local/<runtime>.log`. A runtime with no
configured command cannot be started this way.

## Consumers and aliases

- **Consumers** are the users of a model that PAI cannot see itself, declared
  under `models.consumers` as `{name, runtime, model?, label?}`. PAI's own
  embedding backend and the worker providers are listed automatically.
- **Aliases** (`models.labels`) give a runtime, or one model of a runtime, a
  readable name: `labels: {ollama: "Chat helper"}` or
  `labels: {ollama: {"qwen3:8b": "Summaries"}}`. A consumer's `label` also names
  the model's purpose. The embedding consumer's title is `models.embeddingLabel`
  (default `PAI memory embeddings`). The cockpit's Models cards show these.

## How PAI finds the running local model

The daemon computes the answer every 30 seconds and caches it in the workers log
directory. `pai worker local`, `--local` runs, the router and the MCP tool
`local_status` only read that cache; they fall back to a direct probe only when
the cache is missing or stale. Sessions should never probe ports or start model
servers themselves.

Local runs are scheduled by the router, one request per engine at a time (see
[router](router.md)).

## Routing a task to a local model

Whether a task belongs on a local model is decided by deterministic rules; after
two failed local attempts the next start goes to the cloud. See
[../local-routing.md](../local-routing.md).

Setting this up for the first time: [first workers](../install/first-workers.md).
