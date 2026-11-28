/**
 * Short, always-loaded essentials of the pai MCP server. The full guidance is NOT
 * duplicated here: its single source is skills/PAI/SKILL.md, served as the resource
 * skill://pai/SKILL.md and the prompt `pai-skill` (see skill.ts). The longer
 * CLAUDE.md block (harness/instructions.ts) is a separate, installed artefact.
 */
export const PAI_INSTRUCTIONS = `PAI: federated memory, project registry, sessions, code graph, workers. FULL GUIDANCE: read the MCP resource skill://pai/SKILL.md (or fetch the prompt "pai-skill") before first use; the essentials follow for clients without resource support.

- Before answering about past work, decisions, people or project status, call memory_search. Run project_detect at session start.
- Code questions: code_explore / code_search / code_callers before grep.
- Session commands: go / continue / weiter -> read TODO.md "## Continue" and resume; pause -> update it and stop; end -> pause plus rename the session note.
- Delegating code changes: small -> queue_add, queue_run, queue_review; larger -> plan_save, plan_run, plan_status; discussion -> brainstorm_start; single job -> worker_run (never a subagent). Set deliverable findings (answer/report) or change (commit).
- Where it runs: "locally" -> where local; "on the cloud" -> where cloud; "fast" -> model fast; "now" -> now true. Never pick a local provider by name. Tell the user where each result ran.
- Report in plain words; never ask the user to run commands.
- Config: before hand-editing ~/.pai/config.yaml or workers.yaml run pai config arm, afterwards pai config confirm; config_set does both.
- Other skills are prompts (prompts/get { name }); reference docs are resources (pai://constitution, pai://worker-setup, ...).
`;
