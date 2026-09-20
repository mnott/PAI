# workers.yaml

One hand-editable file: which providers PAI can run workers on, the model
each provider uses per role, and which provider every `--class` goes to.
Before this, that lived inside `~/.config/pai/config.json`'s `workers`
section — JSON, unrelated to the rest of that file, and undocumented in
place. Adding a provider meant reading code to find out what fields existed.

## Where it lives

`~/.claude/pai/workers.yaml` — under the PAI_HOME namespace dir, beside
PAI's other per-user files (`config.json`, `whisper-rules.md`,
`advisor-mode.json`), so nothing PAI writes can collide with a file Claude
Code itself introduces under `~/.claude`. Set `PAI_WORKERS_YAML=<path>` to
override this — tests and power users only, and `PAI_HOME=<dir>` to move
the whole namespace. Only providers, model roles, class routing and MCP
sets live here. Everything else worker-related — the follow-pane profile,
log dir, routing cooldown, sub-worker caps, cache-keepalive cadence, the
machine-wide fallback switch — stays in `config.json`'s `workers` section;
none of it is provider-specific enough to want hand comments.

This file is per-user state: it can hold API keys (`key:`, below), is kept
mode 0600, and is never committed or shared.

Before 2026-09-19 it lived at `~/.config/pai/workers.yaml`, and briefly at
`~/.claude/workers.yaml` in between. If yours is still at either old
location, `pai worker config check` and `pai worker providers` say so;
`pai worker config migrate` (or `pai config migrate`) moves it — a
byte-for-byte copy, no JSON involved, with the old file renamed aside as
`workers.yaml.migrated-<date>` rather than deleted.

## The file

```yaml
# PAI worker configuration.
# Providers PAI can run workers on, the model each role uses, and which
# provider every --class goes to. Edit by hand; `pai worker providers` shows
# the effective result. Comments are preserved when PAI writes this file.
#
# Per-user state, kept 0600: this file can hold API keys (`key:`, below).
# Never commit it or share it. `key_file: <path>` keeps a secret in its own
# 0600 file instead, if you'd rather not put it here.

active: anthropic          # provider for `pai worker run` without --provider or --class

providers:
  anthropic:
    builtin: true          # Claude Code's own login: no url, no key file
    models:
      default: claude-sonnet-5
      fast: claude-haiku-4-5-20251001
  glm:
    url: https://api.z.ai/api/anthropic
    key: "<your-api-key>"   # or key_file: <path to a 0600 file>
    tier: 3
    models:
      default: glm-5.3[1m]
      fast: glm-5.3-flash
      image: example-paint
  kimi:
    url: https://api.kimi.ai/coding/
    key: "<your-api-key>"   # or key_file: <path to a 0600 file>
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
- **`providers.<name>.key`** — the API token inline, quoted. Wins over
  `key_file` when both are set (`pai worker config check` notices this).
  Never printed back — `pai worker providers` and `config check` render it
  as `key ****`+ the last 4 characters.
- **`providers.<name>.key_file`** — path to a 0600 file holding the API
  token instead, if you'd rather keep it out of this file. Omit both for a
  local server with no auth (the runner sends the placeholder token
  `"local"`). `pai worker config inline-keys` moves an existing `key_file`
  inline.
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

## Provider protocol shapes

Every provider is one of three shapes. Which one is a YAML edit, never code —
the loader, writer and `config check` all round-trip `protocol`, `engine` and
`upstream_url` the same way (snake_cased in YAML, matching `url`/`key_file`);
see `src/workers/config.ts` and `src/workers/workers-config.ts`.

**(a) Anthropic-compatible endpoint** — `glm`/`kimi` above: a `url` (the
Messages API base) and a `key`/`key_file`. No `protocol` field — `anthropic`
is the default and Claude Code talks to the endpoint directly.

**(b) OpenAI-compatible remote** — `protocol: openai` routes the provider
through the built-in Anthropic↔OpenAI proxy (`docs/worker.md`, "The proxy");
`upstream_url` is the Chat Completions base instead of `url`:

```yaml
providers:
  openai:
    protocol: openai
    upstream_url: https://api.openai.com/v1
    key: "<your-api-key>"
    tier: 3
    models:
      default: gpt-5.2       # placeholder — check current OpenAI model ids
      fast: gpt-5.2-mini      # placeholder
```

**(c) Local model** — same `protocol: openai` shape, pointed at a loopback
server with no `key`/`key_file` (the runner sends the placeholder token
`"local"`):

```yaml
providers:
  ollama:
    protocol: openai
    upstream_url: http://localhost:11434/v1
    tier: 1
    models:
      default: llama3.3       # placeholder — whatever you've pulled locally
```

LM Studio and llama.cpp's server mode speak the same OpenAI-compatible
Chat Completions API — the same shape works, just with that tool's own port
in `upstream_url` (LM Studio defaults to `1234`, llama.cpp's `server` binary
to `8080`).

`engine: codex` (either protocol shape) runs the provider on the Codex CLI
instead of Claude Code — see `docs/worker.md`, "The codex engine".

Shapes (b) and (c) validated, each written to its own file and checked with
an isolated `$HOME` so nothing touched the real config:

```
$ HOME=/tmp/pai-isolated-home pai worker config check /tmp/openai-remote-check.yaml
/tmp/openai-remote-check.yaml OK — 1 provider(s), 3 class(es)
  warning: /tmp/openai-remote-check.yaml contains a key: field but is mode 644 — chmod 600 /tmp/openai-remote-check.yaml

$ HOME=/tmp/pai-isolated-home pai worker config check /tmp/local-model-check.yaml
/tmp/local-model-check.yaml OK — 1 provider(s), 3 class(es)
```

Both exit 0. The mode warning on (b) is `config check` doing its job — a
file with an inline `key:` gets flagged when it isn't 0600; (c) has no key,
so no warning. Neither run was launched against — these are shape checks
only, no worker spawned on either.

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
(comments elsewhere in the file are untouched). `--key-file` (above) and
`--key` are alternatives — `--key <token>` writes the token inline as
`key:` (quoted) instead of a file path:

```
pai worker providers add kimi \
  --url https://api.kimi.ai/coding/ \
  --key sk-… \
  --model 'k3[1m]' --fast-model 'kimi-for-coding[1m]' \
  --cost-tier 3
pai worker classes set research kimi/fast
```

`pai worker providers use kimi` makes it the default target for
`pai worker run` with no `--provider`/`--class`.

## Starting the harness on another provider

`pai worker providers`/`classes` route delegated subagent work. `pai launch`
is the analogous door for the harness itself — the interactive session you
are typing into, not a worker it spawns.

A running `claude` process cannot change provider: its base URL and auth
token are fixed for the life of the process. So "switch provider" always
means "start a new session", and `pai launch` is the one place that turns
"start on `<provider>[/<model>]`" into a fresh `claude` process, reading the
same `workers.yaml` as everything else — adding a provider there makes it
available here with no other change.

```
pai launch                          # numbered table in a terminal; pick one
pai launch --list                   # print the table and exit (also non-TTY)
pai launch --provider glm                        # that provider's default model
pai launch --provider glm --model glm-5.3-flash  # a specific model
pai launch --provider glm -- --resume <id>       # extra args pass to claude
pai launch --provider glm --dry-run              # print argv/env (key masked), don't exec
```

The table lists the built-in `anthropic` provider first, then every
**enabled** configured provider, one row per model capability
(default/fast/image) it declares — a disabled provider does not appear, and
neither does a capability the provider has not set. `--model` must name one
of the values shown for that provider; a provider name has to be one of the
rows too. Either mistake exits 2 and names the valid ones instead of
guessing.

**Why this exists:** Claude Code's own `/model` command only ever lists the
models of whatever endpoint the CURRENT process is already talking to —
started plainly it shows Anthropic models, started against a provider's base
URL it shows that provider's, and there is no way to ask it about a provider
the process was not started with. From inside a running session, the
`/providers` skill (`pai launch --list --current`) shows the full table
instead, with the row matching the session's own provider/model marked when
it can be determined from the environment.

The `glm`/`kimi` shell shims (installed by `pai worker install`) are thin
aliases of `pai launch --provider glm`/`kimi` — typing `glm` has always meant
"an interactive session pinned to the glm endpoint," not whatever provider
happens to be `active` right now.

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

## Migrating from the JSON config, or from the old workers.yaml location

```
pai worker config path        # where workers.yaml resolves to
pai worker config init        # first machine, no config yet: write the starter
pai worker config migrate     # JSON workers section → workers.yaml, or old location → new
pai worker config migrate --dry-run   # print the plan, change nothing
pai worker config check       # validate the current workers.yaml (file:line on error)
pai worker config inline-keys # move every key_file's contents inline as key: (quoted)
```

`migrate` does one of two things, chosen from what is actually on disk:

- **workers.yaml still at an old location** (`~/.claude/workers.yaml`, or
  older still `~/.config/pai/workers.yaml`): moved byte-for-byte to
  `~/.claude/pai/workers.yaml` — no JSON involved, nothing transformed, and
  the old file is renamed aside as `workers.yaml.migrated-<date>` rather
  than deleted.
- **no workers.yaml yet**: reads the JSON `workers` section, writes
  workers.yaml with the same header/section comments as the starter, backs
  the pre-migration JSON section up to `workers.json.migrated-<date>` next
  to `config.json`, and strips `providers`/`classes`/`roles`/`mcpSets`/
  `active` from the JSON (everything else in that section — pane, log dir,
  routing, tree, cache-keepalive, fallback — stays).

Either way it refuses to run a second time unless passed `--force`, so it
is safe to attempt again after checking the result.

`inline-keys` is separate: for a workers.yaml that already exists, it reads
each provider's `key_file` and rewrites it as an inline, quoted `key:`,
leaving the key file itself on disk (it prints the paths so you can remove
them yourself). `--dry-run` prints which providers would be touched without
writing anything.

## Where PAI lives

PAI is not a Claude Code plugin — it is a self-contained system that Claude
Code happens to be the first harness for. `~/.claude/pai/` (`PAI_HOME`) is
the single home for everything PAI owns: `config.json`, `workers.yaml`,
`whisper-rules.md`, `advisor-mode.json`, `session-state/`, `queries/`,
`logs/workers/` and the rest of PAI's per-user state and caches. `pai config
path` prints where every one of these currently resolves to; `pai config
migrate` moves whatever is still at an old location into PAI_HOME (byte-for-
byte, old copy renamed `.migrated-<date>` rather than deleted, never a
second time without `--force`).

`pai backup`/`pai restore` snapshots live under `PAI_HOME/backups/` (falling back to the pre-2026-09-19 `~/.pai/backups/`), with pre-PAI_HOME runs kept under `PAI_HOME/backups/legacy-pai-backups/`.

`~/.claude/` itself is a **harness adapter**, not a second home. It holds
only what Claude Code requires at fixed, hardcoded paths — and every one of
those entries is either a symlink into the PAI repo/`dist/` (hooks under
`Hooks/`, skills under `Skills/`, `statusline-command.sh`,
`tab-color-command.sh`, the `worker-status-line.mjs` standalone script), a
symlink into `PAI_HOME` (`Agents/` → `PAI_HOME/agents/`, `Commands/` →
`PAI_HOME/commands/` — see below), or, for the handful of files Claude Code
has no build step for and that are deployed once by hand
(`Hooks/block-taskoutput-wait.mjs`, `Hooks/post-compact-workers.mjs`,
`Hooks/route-edits-to-worker.mjs`, the `pre-commit*` templates,
`Hooks/ztk-auto.sh`), a real file with no PAI-owned copy elsewhere to
symlink from. Nothing else of PAI's is meant to sit loose in `~/.claude` —
anything found there outside this adapter set is a leftover from before
PAI_HOME existed, not a second storage location. `Skills/` is left as a
harness-only dir in this pass — not folded into `PAI_HOME/skills/`.

A future harness (OpenCode or otherwise) would need its own adapter — a
different directory, its own fixed hook/skill registration points — but it
would point at the *same* `PAI_HOME`, so switching harnesses never means
migrating PAI's own state.

### PAI_DIR → ADAPTER_DIR, and the rest of the 2026-09-19 fold

`~/.claude/Hooks/lib/pai-paths.ts` used to define `PAI_DIR` (default
`~/.claude`) as both "where the adapter lives" and, via `HISTORY_DIR =
join(PAI_DIR, 'History')`, an anchor for PAI's own captured state — the two
concepts this whole doc distinguishes, collapsed into one name. `PAI_DIR` is
now **`ADAPTER_DIR`** (same default, same env-var override); `PAI_DIR` keeps
working as a deprecated alias for one release, with a one-time stderr notice
on every process that sets it. State that used to hang off `PAI_DIR` now
resolves under `PAI_HOME`, with the same old-path fallback + notice used
everywhere else in this file:

- **`History/`** (`historyDir()`), **`agent-sessions.json`**
  (`agentSessionsPath()`), **`session-routing.json`**
  (`sessionRoutingPath()`) and **`History/security/security-events.jsonl`**
  (`securityEventsPath()`) — all in `src/hooks/ts/lib/pai-paths.ts`. These are
  written by hooks on **every** session's every turn, not just spawned
  workers, so unlike the rest of this file the live move is never automatic:
  `pai config migrate --history` refuses while any spawned worker other than
  the interactive session is RUNNING (`pai worker ps`), and that guard still
  cannot see *other* interactive `claude` processes on the machine — confirm
  none are active (`ps aux | grep claude`) before passing the flag. As of this
  writing the move is deferred; the fold landed as code + fallback only.
- **`registry.db`** — `src/registry/db.ts`'s `registryDbPath()`, folded in
  from the third per-user location it lived at, `~/.pai/registry.db`. Moved
  live as part of a plain `pai config migrate` (same open-fd-and-restart-the-
  daemon caution as `federation.db` above), with an extra WAL checkpoint
  before the copy and a `PRAGMA integrity_check` after it (when the `sqlite3`
  CLI is present) — a SQLite file in WAL mode can have unflushed writes
  sitting in a `-wal` sidecar that a plain byte-copy of the `.db` file alone
  would silently drop.
- **`agents/`, `commands/`** — the operator's authored `~/.claude/Agents/*.md`
  and `~/.claude/Commands/*.md`, PAI content with no PAI-owned copy before
  now. `pai config migrate` moves their contents into `PAI_HOME/agents/` and
  `PAI_HOME/commands/`, then leaves a directory symlink at the old
  `~/.claude/Agents` / `~/.claude/Commands` path — confirmed empirically that
  Claude Code follows a directory symlink for `.claude/agents/` (a project-
  level symlinked `agents/` dir was picked up by a fresh `claude -p` run
  listing its available subagent types) before relying on it here. `bun run
  build`'s `--sync` step (`scripts/build-hooks.mjs`) keeps both symlinks
  current on every build, the same way it already does for `Hooks/` and
  `Skills/` — but only once `PAI_HOME/agents/` and `PAI_HOME/commands/` exist
  on a given machine; it never touches a real, un-migrated `Agents/`/
  `Commands/` directory.

Deferred live move, to run once no other `claude` process is active:

```
pai config migrate --history
```
