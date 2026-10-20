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
