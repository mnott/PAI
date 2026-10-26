# OpenCode as a PAI frontend

OpenCode is the chat; PAI is the bridge. The orchestrating session runs in OpenCode, talks to PAI through its MCP server and starts legitimate Claude Code sessions as PAI workers (`pai_worker_run`, `pai_queue_run`, `pai_plan_run`). Checked against OpenCode 1.19.3.

## Setup

```
pai harness setup opencode                 # dry run: what would be written
pai harness setup opencode --write         # apply; changed files are backed up as <file>.bak-<stamp>
pai harness setup opencode --write --provider glm --model glm-5   # also run OpenCode's own model through the PAI router
```

Everything goes into OpenCode's global config dir (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`; `--config-dir` overrides):

| File | Content |
| --- | --- |
| `opencode.json` | `mcp.pai` (same command/args as `mcpServers.pai` in `~/.claude.json`), `instructions`, `command.*`, `plugin`, with `--provider` also `provider.pai` + `model` |
| `pai/AGENTS.md` | PAI's instructions rendered for OpenCode |
| `pai/pai-bridge.mjs` | the guard plugin (copy of `templates/opencode/pai-bridge.mjs`) |

An existing `opencode.json` is merged, never replaced: your keys stay, PAI's `mcp.pai`, `command.*` and bridge plugin entry are refreshed. `opencode.jsonc` is never touched (OpenCode reads both). Run the command again after `pai update`.

`--all-mcp` registers every Claude Code MCP server, not only `pai`. Header and env values are written as `{env:NAME}` references, never as literals; the command lists the names that must be exported.

## One instruction source

`src/harness/instructions.ts` (the MCP server's text) and `templates/claude-md.template.md` (CLAUDE.md) are the only sources. Text that names a harness sits between `<!-- only:claude-code -->` / `<!-- only:opencode -->` and `<!-- /only -->`; `{{INSTRUCTIONS_FILE}}` is `CLAUDE.md` or `AGENTS.md`. `renderInstructions(harness, template, home)` renders both for Claude Code (`pai setup`, `pai update`, the MCP server) and for OpenCode (`pai harness setup opencode`). Examples that said `Task(...)` read `spawn(...)`; each harness section says what `spawn` is there.

## Commands and skills

- Commands: every `~/.claude/commands/*.md` becomes an OpenCode command (`command.<name>` with `description` and `template`).
- Skills: OpenCode reads `~/.claude/skills/*/SKILL.md` itself (`opencode debug skill` lists them), so nothing is copied. The setup output lists them.

## Hook parity

OpenCode plugins (`@opencode-ai/plugin`) offer `tool.execute.before/after`, `chat.message`, `event`, `permission.ask`, `shell.env`, `experimental.session.compacting`, `experimental.chat.system.transform`. The bridge plugin implements the guards by running PAI's own Claude Code hooks (`dist/hooks/*.mjs`) unchanged: Claude-shaped JSON on stdin, exit 2 or `permissionDecision: deny` blocks the tool call and the model sees the reason. A hook that cannot run allows.

| Claude Code hook (settings.json) | Event | OpenCode equivalent | Status |
| --- | --- | --- | --- |
| `route-agents-to-worker` | PreToolUse Agent/Task | `tool.execute.before` on `task` | bridged |
| `route-edits-to-worker` | PreToolUse Edit/MultiEdit/Write | `tool.execute.before` on `edit`/`write`/`multiedit`/`patch` | bridged |
| `block-sleep-poll` | PreToolUse Bash | `tool.execute.before` on `bash` | bridged |
| `security-validator` (secrets, destructive commands) | PreToolUse Bash | `tool.execute.before` on `bash` | bridged |
| `worker-guard`, `worker-path-repair`, `worker-tool-name-repair` | PreToolUse * | not needed: they act on worker sessions, which stay Claude Code | n/a |
| `block-taskoutput-wait` | PreToolUse TaskOutput | OpenCode has no TaskOutput tool | n/a |
| `terminal_guard.py`, `ztk-auto.sh`, `caseleaf-warm-builds.sh` | PreToolUse Bash | `tool.execute.before` on `bash` | missing (personal setup; add to `BRIDGED_HOOKS` if wanted) |
| `aibroker-progress`, `aibroker-rename-title` | PreToolUse Task / MCP | `tool.execute.before` | missing (AIBroker-specific) |
| `ab-levers pre/post/stop`, `capture-all-events`, `capture-tool-output`, `observe`, `update-tab-on-action`, `sync-todo-to-md`, `whisper-reinject` | PostToolUse | `tool.execute.after` | missing (observation capture and tab titles; OpenCode keeps its own session DB, which `pai harness sessions` reads) |
| `load-core-context`, `load-project-context`, `initialize-session`, `inject-observations` | SessionStart | `experimental.chat.system.transform` | missing; `pai/AGENTS.md` carries the static part, the session start steps (`project_detect`, TODO.md "Continue") are in the instructions |
| `post-compact-inject`, `post-compact-workers` | SessionStart compact | `experimental.session.compacting` | missing |
| `context-compression-hook`, `pai-pre-compact.sh` | PreCompact | `experimental.session.compacting` | missing |
| `whisper-rules`, `cleanup-session-files`, `update-tab-titles`, `local-model-hint`, `budget-stop`, `drain-mailbox`, `manage-hook`, `operator-manage-token` | UserPromptSubmit | `chat.message` | missing |
| `pai-session-autosave.sh` | PostToolUse / UserPromptSubmit | `event` (`session.idle`) | missing |
| `stop-hook`, `pai-session-stop.sh`, `aibroker-route-guard` | Stop | `event` (`session.idle`) | missing |
| `capture-session-summary` | SessionEnd | `event` | missing |
| `subagent-stop-hook` | SubagentStop | none | n/a (no in-process subagents are used) |

The first four rows are the delegation rule (workers through PAI, never inline) and the secret/destructive-command checks. The rest is observation, tab titles and session-note automation; each missing row has a plugin hook it could use, none has been needed to make the frontend work.

## Status line and session notes

OpenCode has no status-line command (its TUI plugin API draws its own sidebar and has no equivalent of Claude Code's `statusLine` script). PAI's status line therefore stays a Claude Code feature; `pai worker ps` / `pai_worker_ps` is the equivalent view. Session notes: the Stop/SessionEnd automation is not wired (see the table). The handover is the same file in both harnesses, the project's TODO.md "## Continue" section (`pai pause`, or write it from the chat), so a Claude Code or OpenCode session picks it up next.

## Proof

With a temp config dir, `opencode run --format json --auto` called `pai_worker_ps` through the generated config and PAI answered; a `sleep 90` bash call was denied by the bridge with the PAI sleep-poll guard text. The model in that run was a stub OpenAI endpoint; a live model through the router (`--provider`) currently fails for OpenAI-format streams while the request is queued, because the router sends Anthropic-style `{"type":"ping"}` keep-alives that the AI SDK rejects.
