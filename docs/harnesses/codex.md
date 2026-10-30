# Codex CLI with PAI

Codex CLI reaches PAI two ways: as a **worker engine** (PAI drives it) and as
a **session source** (PAI reads its logs). There is no way to make Codex a
PAI frontend — `pai harness setup` accepts only `opencode`
(`src/cli/commands/harness.ts`). Checked against the documented
`codex exec --json` interface (`src/workers/codex.ts`).

## As a worker engine

A provider with `engine: codex` runs workers through `codex exec --json
--skip-git-repo-check [-m <model>] -- <prompt>` instead of Claude Code
(`buildCodexArgs`, `src/workers/codex.ts`). The JSONL stream
(`thread.started` / `item.completed` / `turn.completed` / `turn.failed`) is
normalised into claude-code-shaped events, so `follow`, `replay` and the pane
render a Codex worker unchanged.

```
pai worker providers add codex --engine codex --model <model> --key-file <path>
pai worker providers test codex          # probes the CLI; reports "not installed" unless codex is on PATH
pai worker run --provider codex -p '<task>'
```

- **Two shapes.** An API-key provider gets `OPENAI_API_KEY`/`OPENAI_BASE_URL`
  from the provider's key and `upstreamUrl`. A ChatGPT-plan provider has no
  key at all and keeps Codex's own login from `<codex home>` (`~/.codex`, or
  `CODEX_HOME`) — that is the point of the engine: a ChatGPT plan gives no API
  key, only Codex CLI access (`src/workers/codex.ts`).
- **Keyless through the router.** With the router enabled and an API-key
  provider, the run gets a registered run token plus the router's base URL;
  the real key never enters the spawn env (`codexKeyless`, `buildCodexEnv`).
- **Limits.** `--allowedTools`, `--disallowedTools` and MCP flags have no
  Codex equivalent and are dropped with a `WORKER-NOTE` (`codexDroppedFlags`).
  `pai worker resume <id> '<text>'` needs a recorded session id; a Codex
  worker records only its thread id, so resume does not continue its
  conversation (`src/cli/commands/worker.ts`, `src/workers/resume-args.ts`).
  `pai launch --provider codex` is refused: launch starts the Claude Code
  harness only (`src/workers/launch.ts`). Provider fallback (switching a run
  to another provider on quota) needs a claude-engine provider — a codex or
  opencode provider does not take fallback traffic
  (`src/workers/fallback.ts`).

## As a session source

The `codex` adapter (`src/harness/codex.ts`) reads
`<codex home>/sessions/**/rollout-*.jsonl` read-only — user/assistant
messages, `function_call` / `function_call_output`; unknown entry types and
malformed lines are skipped. Enable it in config (`harness.adapters`,
`src/config/defaults/config.yaml`):

```
pai config set harness.adapters [claude-code,codex]   # see docs/config.md
pai harness list                 # adapter rows: detected, enabled, sessions
pai harness sessions --harness codex --cwd <project-dir>
```

PAI never writes to or hooks into Codex; the adapter only replays logs as
events (`src/harness/types.ts`).

## Not supported

- Codex as a frontend: no MCP registration, no instructions, no guard hooks
  — nothing in the code writes a Codex config.
- Session-note automation and the status line: Claude Code features.
- `engine: codex` workers are headless only (`-p '<prompt>'`): no operator
  socket, so `pai worker say` does not reach them mid-run, and resume cannot
  continue their conversation (`executeCliEngineRun`, `src/workers/run/execute.ts`).
