# Launcher Independence

> Verified 2026-09-17: the `pai` session launcher starts sessions on whichever
> worker provider is active — the claude binary, Anthropic credentials and
> `~/.claude` session state are needed only where a claude-format transcript is
> genuinely being resumed, and nowhere else.

## The two launch paths

| Invocation | Code path | Engine decision |
|---|---|---|
| `pai` (bare, tty) | `cmdPick` → `launchInDir(dir, name, { forceFresh: true, engine })` | `resolveLaunchRoute` (src/cli/lib/launch.ts) — active provider wins; `w`/`a` keys force one engine |
| `pai <name>` | `cmdMain` → `openMatch` / registry match → `launchSession` → **`launchInDir`** | same `resolveLaunchRoute` — fresh launch follows the provider; a resumable transcript pins claude |

`resolveLaunchRoute` mirrors the Agent-routing hook's gate: routing on = one
interactive `pai worker run --label <name> --cwd <dir>`; routing off, no active
provider, or an explicit override = `claude`. Resume stays claude by design — a
claude transcript has nothing to resume on another engine.

## The gap that was found and fixed

`launchSession` in `src/cli/commands/main-resolver.ts` spawned `claude` directly
in all three of its branches (resume, resume-fallback, fresh). Every other
launch path had been routed (6adddb5), but this one pinned `pai <name>`,
`pai <uuid>` and history-search launches to Anthropic credentials regardless of
configuration. It was also a third near-copy of the launch dance — the exact
shape that once left `probeResume` fixed in one copy and broken in two.

Fix: `launchSession` now resolves the resumable UUID, directory and display
name, then hands the launch to `launchInDir`. One router, one spawn site per
engine. Verified:

- **Before/after dry-run** (topic match over prompt history, non-resumable
  session, `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL pai <topic> <pick> --dry-run`):
  before → `argv: claude --name …` (would fail to authenticate with the env
  stripped); after → `argv: pai worker run --label … --cwd …`.
- **Resume path unchanged**: the same dry-run against a resumable session still
  prints the probe + `claude --resume` plan — through `launchInDir` now.
- **Unit tests**: `src/cli/lib/launch.test.ts` covers every `resolveLaunchRoute`
  outcome (provider active/off, empty provider map, override keys, resume pins
  claude, forceFresh drops it) and that `probeResume` exists in exactly one
  file; `main-resolver.test.ts` still passes.

## Why the provider needs nothing from Anthropic

`buildRunEnv` (src/workers/run-env.ts) builds the worker child's environment
from the provider config alone: token from the provider's key file,
`ANTHROPIC_BASE_URL` from its `baseUrl`, model overrides from its model map —
and it **deletes `ANTHROPIC_API_KEY`** and disables nonessential traffic. The
`claude` binary serves as the agent runtime, but authentication is entirely the
provider's.

Verified live: a headless `pai worker run` with
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` unset completed
and returned its reply — the active provider (configuration, nothing else)
supplied the credentials. `src/workers/daemon-llm.test.ts` asserts the same
rule for background spawns: the API key never reaches the child, the provider
token and base URL do.

## What still touches claude-only state, deliberately

- **Resume** (`claude --resume <uuid>`, `pai resume`): the transcript format and
  the probe's filesystem layout (`~/.claude/projects/<encoded-cwd>/`) are
  claude's; the probe itself is read-only and spawns nothing.
- **Explicit claude** (`a` in the picker, `engine: "claude"`).
- **Routing off** (`pai worker off`): everything runs claude, as before.

Switching providers (`pai worker providers use <name>`) changes every fresh
launch — picker, name match, UUID, history search — without touching any of
these files again.
