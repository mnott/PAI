/**
 * instructions.ts: the one source of PAI's core instructions, rendered per harness.
 *
 * Text between `<!-- only:NAME[,NAME] -->` and `<!-- /only -->` is kept for those
 * harnesses and dropped for the others; everything else reads the same everywhere.
 */

export type InstructionsHarness = "claude-code" | "opencode";

export const INSTRUCTIONS_TEMPLATE = `## PAI — Personal AI Infrastructure

Federated memory, project registry, session management, skills.

### Search first

Before answering about past work, decisions, people, or project status: use memory_search.
Run project_detect at session start.

### Session commands

- go / continue / weiter → read TODO.md "## Continue" section, resume there
- pause session → update TODO.md "## Continue" section, stop
- end session → pause procedure + rename session note (never leave as "New Session")
- cpp → release order is in the project's instructions file (CLAUDE.md or AGENTS.md)

### Delegating code changes

Edit/Write on code files is denied in this session; you decide the size. A small change: queue_add (one
sentence + files), queue_run, then queue_review and queue_accept / queue_reject / queue_again. A larger job:
write the plan yourself, plan_save, plan_run, follow with plan_status, and at a needs-decision clarify with
plan_amend and plan_run again. Where it runs is the operator's plain words mapped onto the same three optional
arguments of every delegation tool: "locally" -> where local; "on the cloud" -> where cloud; a provider name
("on kimi") -> where <name>; "fast" -> model fast; "immediately / now / first" -> now true.
Never pick a local provider by name; PAI resolves the one that answers. Each result starts with where it runs: tell the user.
Report in plain words; never ask the user to run commands.
Per-session models: session_profile_get / session_profile_set answer and change "switch workers to glm", "what happens if kimi runs out" (fallback list), "use opus for this session by default" (chat), per named session, without touching the global config. "Run them one after the other" -> session_profile_set max_parallel 1 (any provider; this session's workers wait for each other); "in parallel again" -> max_parallel null. "Two local workers" / "local one at a time" -> worker_providers cap <local provider> N (the provider's own cap in workers.yaml; unset, a local provider runs one at a time). Serial is never implied by "local": a provider is serial only with a cap of 1 in its config.

<!-- only:claude-code -->
### Harness: Claude Code

This session is Claude Code: PAI's hooks (settings.json) enforce the delegation and security rules, the Agent tool is
denied (start workers with worker_run, not a subagent), and long Bash waits use \`pai worker wait\`, never sleep loops.
<!-- /only -->
<!-- only:opencode -->
### Harness: OpenCode

This session is OpenCode, the frontend; PAI is the bridge. Workers are Claude Code sessions PAI starts (worker_run,
queue_run, plan_run), never inline work in this chat. The PAI OpenCode plugin enforces the edit, shell and
sleep-poll guards. Session continuity is the project's TODO.md "## Continue" section, the same file Claude Code
sessions read and write.
<!-- /only -->

### Skills

Fetch full instructions with prompts/get { name }. Skills are already listed with USE WHEN descriptions.

### Reference resources

Fetch with resources/read { uri }. Available: pai://aesthetic, pai://constitution, pai://prompting,
pai://prosody-guide, pai://prosody-agent-template, pai://voice, pai://skill-system, pai://hook-system,
pai://history-system, pai://terminal-tabs, pai://mcp-dev-guide, pai://worker-setup

### Core rules

Git: no AI signatures, commit format "type: description", run git remote -v before pushing, never commit
private data. Stack: TypeScript > Python (bun/uv). Mark unverified AI claims with ⚠️ Unverified.
WhatsApp: [Whazaa] → whatsapp_send; [Whazaa:voice] → whatsapp_tts.
`;

const ONLY_BLOCK = /^<!-- only:([\w,-]+) -->\n([\s\S]*?)^<!-- \/only -->\n\n?/gm;

/**
 * The template with the blocks of other harnesses removed and the markers of this one's stripped.
 * `home` (optional) fills `${HOME}`; `{{INSTRUCTIONS_FILE}}` is the harness's instructions file name.
 */
export function renderInstructions(harness: InstructionsHarness, template: string = INSTRUCTIONS_TEMPLATE, home?: string): string {
  let out = template.replace(ONLY_BLOCK, (_m, names: string, text: string) => (names.split(",").includes(harness) ? `${text}\n` : ""));
  out = out.replace(/\{\{INSTRUCTIONS_FILE\}\}/g, INSTRUCTIONS_FILE[harness]);
  return home === undefined ? out : out.replace(/\$\{HOME\}/g, home);
}

export const INSTRUCTIONS_FILE: Record<InstructionsHarness, string> = { "claude-code": "CLAUDE.md", opencode: "AGENTS.md" };
