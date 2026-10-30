# Harnesses

A harness is the chat frontend you type into. PAI works with more than one:
Claude Code is the native one, OpenCode can be made a frontend, and other
harnesses reach PAI as worker engines or as read-only session sources. This
folder documents each way PAI attaches — every claim here rests on the code,
and anything the code does not support is said so.

## How PAI attaches

Three distinct seams, and a harness can use any of them:

1. **The MCP server** (`src/daemon-mcp/index.ts`, one shim per session, all
   shims sharing the PAI daemon). It exposes the memory tools
   (`memory_search`, `memory_get`, …) and the delegation tools
   (`worker_run`, `worker_ps`, `worker_say`, `plan_save`, `plan_run`,
   `queue_add`, `queue_run`, …). Any harness that speaks MCP can register it.
2. **Session-log adapters** (`src/harness/`): read-only ingestion of a
   harness's session store — `pai harness list` / `pai harness sessions`.
   The registry is `src/harness/index.ts` (`claude-code`, `codex`); the
   enabled set is config key `harness.adapters` (default `[claude-code]`,
   `src/config/defaults/config.yaml`). Nothing here writes to or hooks into
   a harness (`src/harness/types.ts`).
3. **Runner engines** (`src/workers/config.ts`, `engine:` on a provider):
   workers run through the Claude Code CLI (default), the Codex CLI
   (`engine: codex`, `src/workers/codex.ts`), the OpenCode CLI
   (`engine: opencode`, `src/workers/opencode.ts`), a UHP server
   (`engine: uhp`, `docs/uhp.md`), or the images API (`engine: image`).
   These are harnesses PAI *drives* as workers — not frontends.

## Overview

| Harness | Frontend (you chat in it) | Session ingestion | Workers on its CLI | Status line | Session-note automation |
| --- | --- | --- | --- | --- | --- |
| Claude Code | yes — native | yes (`claude-code` adapter) | yes (`engine: claude`, default) | yes | yes |
| OpenCode | yes — `pai harness setup opencode` | not supported (no adapter; OpenCode keeps its own session DB) | yes (`engine: opencode`) | no — OpenCode's TUI has no status-line hook; `pai worker ps` is the view | not wired; the handover is the shared TODO.md "## Continue" |
| Codex CLI | no — no setup command exists | yes (`codex` adapter, read-only) | yes (`engine: codex`) | n/a | n/a |
| Any MCP-capable harness | partly: MCP tools work with no PAI setup | not supported | n/a | no | no |

What works from any frontend that registers the MCP server: memory search,
delegation (`worker_run`, `queue_add`, `plan_run`, …), worker control
(`worker_ps`, `worker_replay`, `worker_merge`; `worker_say` only for Claude
engine workers), provider and class management (`worker_providers`,
`worker_model`, `worker_classes`).
What does not work outside Claude Code without the OpenCode bridge: PAI's
Claude Code hooks (delegation guard, sleep-poll guard, security checks) —
OpenCode gets them through the bridge plugin, other harnesses get nothing.
`pai launch --provider …` starts the Claude Code harness only; a provider
whose engine is `codex` or `opencode` is refused
(`src/workers/launch.ts`).

## Pages

- [OpenCode](opencode.md) — making OpenCode a PAI frontend
- [Codex CLI](codex.md) — engine and session ingestion, no frontend
- [UHP servers](uhp.md) — any harness speaking the Unified Harness Protocol, as a worker engine
