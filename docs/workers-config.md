# workers.yaml: key reference

`workers.yaml` holds providers, the delegation tiers, class routing, local model tiers and MCP sets. Everything else worker-related (`pane`, `routing`, `tree`, `pool`, `supervision`, ...) is the `workers` section of `config.yaml`: see [config.md](config.md) and [worker.md](worker.md).

Concepts: [providers](concepts/providers.md) (incl. how to add one), [delegation tiers](concepts/delegation-tiers.md), [local models](concepts/local-models.md).

## Where it lives and how it loads

`~/.pai/workers.yaml` (`pai worker config path` prints the real path; `PAI_HOME` moves the namespace, `PAI_WORKERS_YAML` points at another file, for tests). It can hold API keys, so PAI keeps it mode 0600; never commit or share it.

Load order:

1. Shipped defaults (`src/config/defaults/workers.yaml`), deep-merged **under** the user file: objects merge, arrays replace, user values win. See [config-defaults.md](config-defaults.md). `pai config get <key> --source` shows which file a value came from.
2. The user's `workers.yaml`, validated as a whole; an unknown provider named by a tier or class is a load error naming file and line.
3. A machine that never migrated may still have a JSON `workers` section in `config.json`; it is read when no `workers.yaml` exists.

Every write (`pai worker providers add|use|remove|enable|disable`, `route set`, `classes set`, `pai worker on|off`, the matching MCP tools) goes through one validated atomic write: comments are kept, a `.bak-pai` copy is made, and a failed validation restores the previous file. A worker process refuses to write the live file.

```
pai worker config path             # where it resolves to
pai worker config init             # write the starter (examples/workers.yaml) when none exists
pai worker config check [FILE]     # validate; errors carry file:line
pai worker config migrate [--dry-run] [--force]   # JSON section or old location -> workers.yaml
pai worker config inline-keys      # rewrite every key_file as an inline, quoted key:
```

`migrate` moves a `workers.yaml` from an older location byte for byte (the old file is renamed `workers.yaml.migrated-<date>`), or, with none present, converts the JSON section and strips the moved keys from it. It refuses a second run without `--force`.

## Top-level keys

| Key | Meaning |
|---|---|
| `active` | Provider a bare `pai worker run` uses (no `--provider`, no `--class`); `auto` walks `routing.order`. |
| `providers` | One entry per provider (below). |
| `tiers` | The delegation table (below). |
| `classes` | Class to `provider` or `provider/role` pins. Shipped empty: the class-to-tier mapping is in each tier's `classes`. |
| `capabilities` | Capability to ordered provider list, e.g. `image: [pictures, glm]`. Unlisted: the active provider, then any provider declaring it; if none does the run errors naming this key. `pai worker capability [NAME PROVIDERS|--unset]` edits it. |
| `mcp_sets` | Named MCP server lists for `--mcp NAME`; the shipped `desktop: [clickr]` merges under yours (`desktop: []` removes it). |
| `merge.verify` | Shell command `pai worker merge` runs on the merged tree when no `--verify` is given. |
| `local` | Provider that the `local` entry in a tier and `--local` resolve to; `pai worker local TIER` sets it. Unset: the first enabled local provider. |
| `local_tiers`, `local_launcher` | Start recipes for local models (below). |

## `providers.<name>`

| Field | Meaning |
|---|---|
| `builtin: true` | Claude Code's own login (`anthropic` only): no `url`, no key. |
| `url` | Anthropic-compatible Messages API base. Omit only with `protocol: openai`. |
| `key` / `key_file` | Token inline (wins, never printed back: `key ****` plus the last 4) or path to a 0600 file. Neither: a local server without auth (the placeholder token `local` is sent). |
| `models` | Model id per capability. `default` is required; `fast`, `image` and any name matching `^[a-z][a-z0-9-]*$` are open and fall back to `default`. |
| `protocol: openai` + `upstream_url` | Route through the local Anthropic-to-OpenAI proxy (remote OpenAI-style APIs and local servers such as Ollama, LM Studio, llama.cpp). |
| `engine` | `claude` (default), `codex` (Codex CLI), `opencode` (OpenCode CLI, model via the PAI router), `image` (images API, no process). |
| `tier` | Cost tier 1 cheapest to 5 dearest (default 3); used by `--max-cost-tier` class constraints. |
| `tags` | `code`, `vision`, `image-gen`, `long-context`, `fast`, `reasoning`. |
| `enabled: false` | Skip in routing without deleting the entry. |
| `env` | Extra environment for runs through this provider. |
| `note`, `context_window`, `usage`, `quota_probe`, `quota_skip_at` | Display note, window size, budget endpoint, and quota probe URL with its skip percentage. |
| `worker_model` | `default` or `fast`: model a worker gets here when the request names none. |
| `thinking` | `on` or `off` (default off for non-Anthropic providers: no thinking or effort fields are sent). |
| `model_tiers` | See the next paragraph. |

Full semantics: `src/workers/config.ts`.

### `model_tiers` is not `tiers:`

Two different things share the word. `tiers:` (top level) is the delegation table: t0, t1, t2 with ordered model lists. `providers.<name>.model_tiers` is a per-provider map from a model id to a Claude tier alias (`haiku`, `sonnet` or `opus`): it overrides which of the three `ANTHROPIC_DEFAULT_*_MODEL` pins the model fills (by default `models.fast` is the haiku slot and `models.default` the sonnet slot). It never affects routing. The provider `tier: 1-5` is a third thing, the cost rank.

## `tiers:`

Each row has `id`, `name`, optional `description` and `note`, an ordered `models` list (first available serves, the rest is fallback order), and optionally `classes` (the classes it serves), `default: true` (serves every class no tier lists), `session: true` (the tier `pai launch` starts sessions on) and `escalation` (a mapping carried through as written; nothing in the code evaluates it yet, see [escalation](concepts/escalation.md)). An entry is `provider/model`, `provider/alias`, a provider name (`gyro-m`) or the placeholder `local`, which resolves through the top-level `local:` key. A `tiers:` list in your file replaces the shipped list wholesale. A file without `tiers:` is migrated on read from the retired `orchestrator`/`worker`/`quick` class rows. Shipped rows: [delegation-tiers.md](concepts/delegation-tiers.md).

## `local_tiers:` and `local_launcher:`

Named start recipes for local model servers, used by `pai worker local TIER` and the cockpit. Fields as parsed in `src/workers/local-tiers.ts`:

| Field | Applies to | Meaning |
|---|---|---|
| `provider` | all, required | The worker provider the tier serves; port and served name default from its `url` and default model. |
| `engine` | all | `vllm-mlx` (default), `strata` or `script`. |
| `port` | all | Default: the port in the provider `url`; an error if neither gives one. |
| `served` | all | Model name the server answers with; default: the provider's default model (required for `vllm-mlx`). |
| `label`, `memoryGb` | all | Button and status text (default: the tier name), memory shown on the cockpit button. |
| `flags` | all | Extra start flags (string or list). |
| `model` | `vllm-mlx`, required | Model path; a `*` path segment expands to the first sorted match. |
| `config` | `strata`, required | Strata server JSON; `python` optionally names the interpreter (default `~/strata/.venv/bin/python`). |
| `start` | `script`, required | Start script, run detached. |

`local_launcher:` holds the shared `vllm-mlx` launch: `python`, `script`, `flags`, `template_kwargs`, `env`, `process_match`. Examples and switching: [local-models.md](concepts/local-models.md).

## Changing the model hierarchy

What a run uses is the route table, not a class pin. To change it:

```
pai worker route                                   # tiers and what each resolves to now
pai worker route set t2 gyro-m,anthropic/sonnet    # replace a tier's list; a class names its tier
pai worker route set t1 anthropic/sonnet --note "reasoning"
pai worker route set --session self t2 anthropic/sonnet   # override for one session only
pai worker route clear --session self              # drop the session override
pai worker policy prefer-local                     # rewrite the default tier's order
```

`route set` writes the user `workers.yaml`; tier ids, `classes` and descriptions are edited in the file. To change what the built-in provider's `default` and `fast` ids are, set `providers.anthropic.models` (shipped: the Claude Code aliases `sonnet` and `haiku`). Workers never inherit the interactive session's model.

## Capabilities

`models` picks a model within a provider (`glm/image` runs `glm.models.image`); `capabilities:` picks which provider serves a capability. `pai worker run --capability image -p PROMPT [--size WxH] [--out FILE]` (alias `--for`) resolves through it, then runs an `engine: image` provider (a POST to `{url}/images/generations`, PNG written to `--out`, default `<logDir>/<id>.png`). An explicit `--provider` always wins; a class pinned to a provider (`image: glm/image`) is unaffected. `pai worker capability` with no arguments lists every preference and what it resolves to now.
