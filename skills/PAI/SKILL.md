---
name: PAI
description: How to use the pai MCP server (memory, projects, sessions, code graph, workers, queue, plans, config). USE WHEN a task touches past work or decisions, project status, session handover, delegating code changes to workers, or PAI configuration.
---

# Using the pai MCP tools

PAI is federated memory, a project registry, session management and a worker engine behind one MCP server. The same text is served as the resource `skill://pai/SKILL.md` and the prompt `pai-skill`.

## Search first

Before answering about past work, decisions, people or project status, call `memory_search`. Run `project_detect` at session start.

- Memory: `memory_search` (find), `memory_get` (read a hit), `memory_outline`, `memory_wakeup`, `memory_lessons`, `memory_taxonomy`, `memory_tunnels`, `memory_kg_search`, `memory_feedback`.
- Projects: `project_detect` (which project is this cwd), `project_info`, `project_list`, `registry_search`, `project_health`, `project_setup`, `project_todo`.
- Sessions: `session_list`, `session_profile_get` / `session_profile_set`.
- Issues: `issue_claims`, `issue_stale`.
- Code graph: `code_explore`, `code_search`, `code_callers`, `code_summary`, `graph_related`. Use these before grep.

## Session commands

- go / continue / weiter: read the TODO.md "## Continue" section and resume there.
- pause session: update the "## Continue" section, stop.
- end session: pause procedure, then rename the session note (never leave it as "New Session").
- cpp: the release order is in the project's instructions file (CLAUDE.md or AGENTS.md).

## Delegating code changes

In a delegating session, Edit/Write on code files is denied; you choose the size.

- Small change: `queue_add` (one sentence plus files), `queue_run`, then `queue_review` and accept / reject / `queue_again`.
- Larger job: write the plan yourself, `plan_save`, `plan_run`, follow with `plan_status`; at a needs-decision, clarify with `plan_amend` and `plan_run` again. `plan_stop` ends it.
- Multi-view discussion ("brainstorm", "round table"): `brainstorm_start`, follow with `brainstorm_status`; the result arrives as a message.
- Single worker: `worker_run`. Never use a subagent instead.
- Set deliverable `findings` for jobs whose result is an answer or report, `change` for jobs whose result is a commit.
- Where it runs: "locally" -> where local; "on the cloud" -> where cloud; a provider name -> where <name>; "fast" -> model fast; "immediately / now / first" -> now true. Never pick a local provider by name; PAI resolves it. Each result starts with where it runs: tell the user.
- Report in plain words; never ask the user to run commands.

## Watching and steering workers

`worker_status`, `worker_ps`, `worker_queue`, `worker_replay`, `worker_say` (message a running worker), `worker_mode`, `worker_priority`, `worker_reroute`, `worker_pause`, `worker_resume`, `worker_kill`, `worker_merge` (bring a finished worker's branch back), `worker_gc`, `workers_freeze` / `workers_thaw`, `workers_stop` / `workers_resume`, `build_queue`, `pool_status`, `battery_status`, `urgency_set` / `urgency_clear`. A worker that needs a decision uses `worker_handoff`.

Providers and models: `worker_providers`, `worker_fallback`, `worker_classes`, `worker_model`, `worker_capability`, `models_list`, `local_status`, `worker_toggle`, `model_runtime`.

Per-session models: `session_profile_get` / `session_profile_set` answer "switch workers to glm", "what happens if kimi runs out" (fallback list), "use opus for this session by default", per named session, without touching the global config. "Run them one after the other" -> `session_profile_set` max_parallel 1 (local workers wait for each other; cloud workers are not capped unless max_parallel_scope "all"); "in parallel again" -> max_parallel null. "Two local workers" -> `worker_providers` cap <provider> N.

## Tests, release, operations

- `tests_audit`, `tests_keep` (ledger entry required before a new test file), `tests_prune`.
- `release`, `update_check`, `daemon_service`, `router_service`, `memory_run`, `audit_export`.

## Configuration

`config_list`, `config_get`, `config_set`, `config_unset`. Before hand-editing ~/.pai/config.yaml or ~/.pai/workers.yaml run `pai config arm` (snapshot, 10 min deadline); after the edit run `pai config confirm`. Without a passing confirm the daemon restores the old file. `config_set` and the cockpit editor do both by themselves.

## Other prompts and resources

Other skills are prompts: fetch with prompts/get { name }. Reference docs are resources: resources/read { uri } (pai://constitution, pai://skill-system, pai://hook-system, pai://worker-setup and others).

## Core rules

Git: no AI signatures, commit format "type: description", run `git remote -v` before pushing, never commit private data. Mark unverified AI claims with "Unverified". Long Bash waits run in the background; never sleep-loop.
