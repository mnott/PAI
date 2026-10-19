export const PAI_INSTRUCTIONS = `## PAI — Personal AI Infrastructure

Federated memory, project registry, session management, skills.

### Search first

Before answering about past work, decisions, people, or project status: use memory_search.
Run project_detect at session start.

### Session commands

- go / continue / weiter → read TODO.md "## Continue" section, resume there
- pause session → update TODO.md "## Continue" section, stop
- end session → pause procedure + rename session note (never leave as "New Session")
- cpp → release order is in CLAUDE.md

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
