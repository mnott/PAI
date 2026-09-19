# workers.yaml

One hand-editable file: which providers PAI can run workers on, the model
each provider uses per role, and which provider every `--class` goes to.
Before this, that lived inside `~/.config/pai/config.json`'s `workers`
section — JSON, unrelated to the rest of that file, and undocumented in
place. Adding a provider meant reading code to find out what fields existed.

## Where it lives

`~/.config/pai/workers.yaml`, resolved next to whichever `config.json` is
in effect (so `PAI_CONFIG_DIR`/test overrides move both together — see
`pai worker config path`). Only providers, model roles, class routing and
MCP sets live here. Everything else worker-related — the follow-pane
profile, log dir, routing cooldown, sub-worker caps, cache-keepalive
cadence, the machine-wide fallback switch — stays in `config.json`'s
`workers` section; none of it is provider-specific enough to want hand
comments.

## The file

```yaml
# PAI worker configuration.
# Providers PAI can run workers on, the model each role uses, and which
# provider every --class goes to. Edit by hand; `pai worker providers` shows
# the effective result. Comments are preserved when PAI writes this file.

active: anthropic          # provider for `pai worker run` without --provider or --class

providers:
  anthropic:
    builtin: true          # Claude Code's own login: no url, no key file
    models:
      default: claude-sonnet-5
      fast: claude-haiku-4-5-20251001
  glm:
    url: https://api.z.ai/api/anthropic
    key_file: ~/.config/zai/api_key
    tier: 3
    models:
      default: glm-5.3[1m]
      fast: glm-5.3-flash
      image: example-paint
  kimi:
    url: https://api.kimi.ai/coding/
    key_file: ~/.config/kimi/api_key
    tier: 3
    models:
      default: k3[1m]
      fast: kimi-for-coding[1m]

# A class names a provider, or provider/role to pick a non-default model.
# Workers exist to parallelise and to save cost: the default is Sonnet,
# Haiku for the mechanical classes, and nothing here inherits the
# orchestrating session's model.
classes:
  implement: anthropic
  draft: anthropic
  research: anthropic
  complex: anthropic
  plan: anthropic
  review: anthropic
  spotcheck: anthropic/fast
  simple: anthropic/fast
  image: glm/image

mcp_sets:
  desktop: [clickr]
```

This exact file is `examples/workers.yaml`, and is what `pai worker config
init` writes on a machine with no workers.yaml yet.

- **`active`** — the provider a bare `pai worker run` (no `--provider`, no
  `--class`) uses. `auto` walks `routing.order` from the JSON config instead.
- **`providers.<name>`** — one entry per provider. `anthropic` is reserved
  for Claude Code's own OAuth/Max-plan login: no `url`, no `key_file`, just
  `builtin: true` and an optional `models` override (defaults to Sonnet /
  Haiku if omitted — see "Model hierarchy" below).
- **`providers.<name>.url`** — the Anthropic-compatible Messages API base.
  Omit only when `protocol: openai` (below).
- **`providers.<name>.key_file`** — path to a 0600 file holding the API
  token. The key itself never goes in this file. Omit for a local server
  with no auth (the runner sends the placeholder token `"local"`).
- **`providers.<name>.tier`** — cost/quality tier, 1 (cheapest) … 5 (most
  expensive), default 3. Classes can constrain auto-routing to a max tier.
- **`providers.<name>.models`** — model id per capability. `default` is
  required; `fast` and `image` are optional and fall back to `default` when
  a class asks for them and the provider has none.
- **`classes.<name>`** — `provider` or `provider/role` (`role` one of
  `default`, `fast`, `image`). An object form
  (`{provider, mcp, maxCostTier, requireTags, order}`) is also accepted for
  advanced per-class MCP allowlists or routing constraints — see
  `docs/worker.md`.
- **`mcp_sets.<name>`** — named MCP server lists; `--mcp <name>` and a
  class's `mcp` field expand these.

### Optional advanced provider fields

Not in the starter, but read when present (same names `pai worker providers
add` accepts, snake_cased): `enabled: false` (skip in auto-routing without
deleting the entry), `protocol: openai` + `upstream_url` (routes through the
built-in Anthropic↔OpenAI proxy), `engine: codex` (runs the provider on the
Codex CLI instead of Claude Code), `env` (extra environment for runs through
this provider), `note` (shown in `pai worker providers`), `quota_probe` +
`quota_skip_at`, `context_window`, `tags`, `usage`, `model_tiers`. Full field
semantics: `src/workers/config.ts`.

## Adding a provider

Three edits, worked through for `kimi`:

1. **`providers` block** — add the entry:

   ```yaml
   kimi:
     url: https://api.kimi.ai/coding/
     key_file: ~/.config/kimi/api_key
     tier: 3
     models:
       default: k3[1m]
       fast: kimi-for-coding[1m]
   ```

2. **Key file** — put the token where `key_file` points, mode 0600:

   ```
   mkdir -p ~/.config/kimi && chmod 700 ~/.config/kimi
   echo "sk-…" > ~/.config/kimi/api_key && chmod 600 ~/.config/kimi/api_key
   ```

3. **Optional: route a class to it** — e.g. point `research` at kimi's fast
   model:

   ```yaml
   classes:
     research: kimi/fast
   ```

Or the same three edits from the CLI, which writes workers.yaml directly
(comments elsewhere in the file are untouched):

```
pai worker providers add kimi \
  --base-url https://api.kimi.ai/coding/ \
  --key-file ~/.config/kimi/api_key \
  --model 'k3[1m]' --fast-model 'kimi-for-coding[1m]' \
  --cost-tier 3
pai worker classes set research kimi/fast
```

`pai worker providers use kimi` makes it the default target for
`pai worker run` with no `--provider`/`--class`.

## Changing the model hierarchy

Workers exist to parallelise and to save cost: the default tier is Sonnet,
Haiku serves the mechanical classes (`spotcheck`, `simple`), and nothing a
worker runs on inherits the orchestrating session's model — a headless
`claude` with no `--model` takes the interactive session's current model,
which has come up expensive before. To change what a class uses, point it
at a different `provider/role`:

```yaml
classes:
  spotcheck: anthropic/fast   # Haiku (default)
  implement: anthropic        # Sonnet (default)
```

To change what the built-in provider's `default`/`fast` ids actually are,
edit `providers.anthropic.models` (the `builtin: true` entry) — everything
that resolves `anthropic` or `anthropic/fast` picks up the override.

## Load order

1. `workers.yaml`, if it exists — providers, classes, mcp_sets and active
   all come from here, validated as a whole (an unknown provider named by a
   class is a load error naming the file and line, not a spawn-time
   surprise).
2. Else the JSON `workers` section in `config.json` (`providers`, `classes`
   — or the pre-rename `roles` — `mcpSets`, `active`), unchanged from
   before this file existed. Nothing breaks on a machine that has not
   migrated yet.
3. Else built-in defaults (workers off, no providers, the four MCP `desktop`
   default).

Every write (`pai worker providers add|use|remove|enable|disable`, class
changes, `pai worker off`/`on`, the `worker_providers`/`worker_model`/
`worker_toggle`/`worker_fallback` MCP tools) targets whichever source is
active: workers.yaml once it exists, else the JSON section. A write is
re-validated before it is committed; on failure the previous file is left
untouched and the error is reported instead.

## Migrating from the JSON config

```
pai worker config path        # where workers.yaml resolves to
pai worker config init        # first machine, no config yet: write the starter
pai worker config migrate     # existing JSON workers section → workers.yaml
pai worker config migrate --dry-run   # print what migrate would write, change nothing
pai worker config check       # validate the current workers.yaml (file:line on error)
```

`migrate` reads the JSON `workers` section, writes workers.yaml with the
same header/section comments as the starter, backs the pre-migration JSON
section up to `workers.json.migrated-<date>` next to `config.json`, and
strips `providers`/`classes`/`roles`/`mcpSets`/`active` from the JSON
(everything else in that section — pane, log dir, routing, tree,
cache-keepalive, fallback — stays). It refuses to run a second time unless
passed `--force`, so it is safe to attempt again after checking the result.
