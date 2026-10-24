# Providers

A provider is something a worker can run on: Claude Code's own login, a cloud
API, or a model server on your machine. Providers live in `workers.yaml` (path:
`pai worker config path`). The [tier table](delegation-tiers.md) chooses among
them.

## The registry

```
pai worker providers                      # list: models, state, caps, classes
pai worker providers add glm --base-url URL --model ID --key-file PATH
pai worker providers use glm              # make it the active provider
pai worker providers enable|disable NAME  # disable: automatic routing skips it
pai worker providers test glm             # send one word through it
pai worker providers cap NAME 2           # parallel workers on it (maxConcurrent)
pai worker providers update NAME --cost-tier 2 --tags code,fast
pai worker providers remove NAME
```

The first `add` also turns workers on and sets up default classes. A provider
entry carries a base URL, model ids (`default`, `fast`), a key or key file, a
cost tier 1-5 (default 3), capability tags, a context window, an optional quota
probe URL and extra environment.

## The built-in `anthropic`

`anthropic` needs no `add`: it is Claude Code's own login, with no base URL and
no API key. Its shipped models are the CLI's aliases: `default: sonnet`,
`fast: haiku`.

## Adding a provider, worked example

Three shapes, all a YAML edit or one `add` command (keys: [workers-config.md](../workers-config.md)).

1. **Anthropic-compatible endpoint** (GLM, Kimi, ...): a base URL and a token.

```
mkdir -p ~/.config/kimi && chmod 700 ~/.config/kimi
echo "TOKEN" > ~/.config/kimi/api_key && chmod 600 ~/.config/kimi/api_key
pai worker providers add kimi --url https://api.kimi.ai/coding/ \
  --key-file ~/.config/kimi/api_key --model 'k3[1m]' --fast-model 'kimi-for-coding[1m]' --cost-tier 3
pai worker providers test kimi
```

   `--key TOKEN` stores the token inline in `workers.yaml` instead. The same provider in YAML:

```yaml
providers:
  kimi:
    url: https://api.kimi.ai/coding/
    key_file: ~/.config/kimi/api_key
    tier: 3
    models: {default: "k3[1m]", fast: "kimi-for-coding[1m]"}
```

2. **OpenAI-compatible remote**: `--protocol openai --upstream-url https://api.openai.com/v1`, token and `--model` as above. It runs through the local proxy.
3. **Local server** (Ollama, LM Studio, llama.cpp): the same openai shape on loopback with no key, for example `--protocol openai --upstream-url http://localhost:11434/v1 --model llama3.3`. For engines PAI starts itself, see [local models](local-models.md).

Then put the provider where you want it: add `kimi/k3[1m]` to a tier with `pai worker route set t2 ...` ([delegation tiers](delegation-tiers.md)). `pai worker providers use kimi` makes it the active provider and repoints classes pinned to another provider. `pai worker config check` validates the file.

## Protocols and engines

| Option on `add` | Values |
|---|---|
| `--protocol` | `anthropic` (default), or `openai` (needs `--upstream-url`; runs through the local proxy, `pai worker proxy`). |
| `--engine` | `claude` (default), `codex` (ChatGPT plan through the Codex CLI), `image` (image generation). |

## Capabilities

Tags (`code`, `vision`, `image-gen`, `long-context`, `fast`, `reasoning`) say
what a provider is good at. `pai worker capability NAME PROVIDER[,...]` chooses
who serves a capability such as `image`; `pai worker run --capability image`
uses it.

## Local and cloud

A cloud provider is a remote API and is uncapped unless you set a cap. A local
provider serves a model on loopback; by default it runs one worker at a time and
is reached through the [router](router.md). Never name a local provider in a
command: `--local` picks the running one. See [local models](local-models.md).

## Holding a provider

`pai worker providers hold NAME --reason TEXT` queues new work for a provider
while running work continues: queued runs show `held: <reason>` in their queue
line, the pool keeps no idle spares for it, and nothing falls back to another
provider. Benchmark-labelled runs are not held. `pai worker providers release
NAME` lifts it. MCP: `worker_providers` with `action: "hold"` (needs `reason`)
or `"release"`.

## Independence from one vendor

Every spawn builds its environment from the provider alone: its base URL, token
and model ids; `ANTHROPIC_API_KEY` is removed. The route is repeated with
`--settings`, which outranks user settings, so a machine-wide proxy cannot swallow
a worker's route. Only the interactive session needs Claude Code; to start the
session itself on another provider use `pai launch --provider NAME [--model M]`
(`--list` shows all), and `pai worker fallback on [PROVIDER]` moves every new
Claude Code process when the Anthropic plan is out.

## Reference

The long forms stay as reference: [../worker-providers.md](../worker-providers.md) (pointer),
[../provider-abstraction.md](../provider-abstraction.md),
[../provider-independence.md](../provider-independence.md),
[../provider-independence-details.md](../provider-independence-details.md),
[../launcher-independence.md](../launcher-independence.md). Config keys:
[../workers-config.md](../workers-config.md).
