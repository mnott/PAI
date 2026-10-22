# Everything PAI does

One page, grouped by what you want to do. Each item gives the command to type or the phrase to say to Claude, and a link to the detail. Every command has a generated page under [commands](commands/README.md); `pai help` lists the everyday ones and `pai more` the rest. Skills (the phrases) are listed with their triggers in [Skills](skills.md).

- [Sessions](#sessions)
- [Memory and search](#memory-and-search)
- [Notes and vault](#notes-and-vault)
- [Zettelkasten](#zettelkasten)
- [Journal, review and plan](#journal-review-and-plan)
- [Tasks and task bus](#tasks-and-task-bus)
- [Workers and delegation](#workers-and-delegation)
- [Router and cockpit](#router-and-cockpit)
- [Messaging](#messaging)
- [Rules, budget and advisor mode](#rules-budget-and-advisor-mode)
- [Images, art and sharing](#images-art-and-sharing)
- [Research](#research)
- [Setup and health](#setup-and-health)

## Sessions

### Pick and open a session

`pai` shows your sessions; type to filter, Enter opens one. `pai NAME` opens it by name, `pai ls` lists them newest first, `pai new` starts one in a new or existing folder. See [session management](session-management.md), [`pai ls`](commands/ls.md), [`pai new`](commands/new.md), [`pai open`](commands/open.md).

### Pause and end a session

`pai pause` saves your place; `pai end` finishes with a note, TODO update and commits. Say "pause" or "wrap up" to Claude for the same. See [`pai pause`](commands/pause.md), [`pai end`](commands/end.md), [session management](session-management.md#pausing-and-ending).

### Name and rename sessions

`pai rename`, or say "name this session". See [`pai rename`](commands/rename.md).

### Session setups

`pai setups` lists orchestrator and worker combinations; `pai setups save "my mix"` keeps the current one, and `pai NAME --with "glm only"` starts a session that way. See [`pai setups`](commands/setups.md) and [session profiles](session-profiles.md).

### Session notes

Every session writes its own notes in the background. `pai notes list` shows them; say "consolidate notes" to merge duplicates or "reconstruct sessions" to rebuild notes from old transcripts. See [session notes](session-notes.md), [`pai notes`](commands/notes.md).

### Context preservation and auto-compact

When Claude compresses a long conversation, PAI saves a checkpoint first and puts it back afterwards, so work carries on. See [context preservation](context-preservation.md) and [auto-compact](auto-compact.md).

### Which project is this

Say "what project is this" or "tag this session"; `pai topic check` detects when a conversation has moved to another project. See [`pai topic`](commands/topic.md).

## Memory and search

### Search your memory

`pai memory search "text"`, or say "search memory for X". Modes are keyword, semantic (by meaning) and hybrid. See [search](search.md), [`pai memory`](commands/memory.md).

### Search past sessions

Say "what did we do about X" or "search history"; `pai find "text"` searches your prompt history for sessions. See [`pai find`](commands/find.md).

### Index and embeddings

`pai memory index` scans your notes and project files, `pai memory embed` adds meaning vectors, `pai memory status` shows progress, `pai memory backend` and `pai memory settings` choose and tune the backend. See [memory](memory.md#embedding-backends).

### Knowledge graph

`pai kg query`, `pai kg list` and `pai kg stats` show facts extracted from your notes together with the time they were true; `pai kg backfill` extracts them from older notes. See [knowledge graph](memory.md#temporal-knowledge-graph), [`pai kg`](commands/kg.md).

### Memory tools for Claude

Claude can call `memory_search`, `memory_get`, `memory_outline` (section-aware reading), `memory_kg_search`, `memory_wakeup`, `memory_taxonomy`, `memory_tunnels` and `memory_feedback` itself. See [memory](memory.md) and [search](search.md#section-aware-retrieval).

### Observations

Notes the system takes while you work. `pai observation list`, `pai observation search "text"`, `pai observation stats`. See [observations](observations.md), [`pai observation`](commands/observation.md).

### Projects and registry

`pai project list`, `add`, `rename`, `check`; `pai registry scan` finds projects on disk; `pai cd NAME` goes to a project's directory. See [`pai project`](commands/project.md), [`pai registry`](commands/registry.md), [`pai cd`](commands/cd.md).

## Notes and vault

These use your Obsidian vault (`vaultPath` in the config).

### Mirror project notes into Obsidian

`pai obsidian sync` copies project notes into the vault, `pai obsidian status` shows the state, `pai obsidian open` opens it. See [`pai obsidian`](commands/obsidian.md).

### Morning briefing

Say "morning briefing" or "load vault context". Skill `/vault-context`. See [skills](skills.md#obsidian-vault).

### Connect two ideas

Say "how does X relate to Y". Skill `/vault-connect` finds the path between two topics in the vault. See [skills](skills.md#obsidian-vault).

### Find orphans

Say "find orphans". Skill `/vault-orphans` finds notes nothing links to and suggests where to link them. See [skills](skills.md#obsidian-vault).

### What is emerging

Say "what's emerging" or "find patterns". Skill `/vault-emerge` surfaces themes and clusters. See [skills](skills.md#obsidian-vault).

### Trace an idea

Say "trace the idea X" or "how did X evolve". Skill `/vault-trace` follows an idea through your notes over time. See [skills](skills.md#obsidian-vault).

## Zettelkasten

PAI indexes the links and meaning of your vault. Details: [Zettelkasten](zettelkasten.md); all commands: [`pai zettel`](commands/zettel.md). Say the phrase to Claude, or type the command.

### Explore links

`pai zettel explore NOTE --depth 2`, or "explore notes linked to X". Walks links outward from a note.

### Surprising connections

`pai zettel surprise`, or "find surprising connections to this note".

### Ask the vault

`pai zettel converse`, or "what does my vault say about X".

### Themes

`pai zettel themes`, or "what themes are emerging in my vault".

### Vault health

`pai zettel health`, or "how healthy is my vault". A structural audit of links and orphans.

### Link suggestions

`pai zettel suggest`, or "suggest connections for this note".

## Journal, review and plan

### Journal

Say "journal" or "note to self". Skill `/journal` creates, reads and searches personal entries. See [skills](skills.md#productivity).

### Review

Say "review my week" or "what did I do". Skill `/review` writes a daily, weekly or monthly recap. See [skills](skills.md#productivity).

### Plan

Say "plan my week" or "what should I focus on". Skill `/plan` plans from your open tasks and calendar. See [skills](skills.md#productivity).

### Explain as a story

Say "explain this as a story". Skill `/story` writes a numbered narrative of any content. See [skills](skills.md#tools--system).

## Tasks and task bus

### Cross-session task list

`pai task list`, `pai task add`, `pai task done`; or say "add a task" or "what's on the bus". Skill `/tasks`. See [`pai task`](commands/task.md).

### Todoist as an input channel

`pai task poll` and `pai task schedule` pick up Todoist tasks and `pai task dispatch` hands them to a session; `pai task config` sets it up. See [task bus](task-bus.md).

### Issue claims

`pai issue` claims and releases forge issues so two sessions do not take the same one. See [issue claims](issue-claims.md), [`pai issue`](commands/issue.md).

## Workers and delegation

### Run a worker

Say "start a worker" or run `pai worker run`. A worker is a background Claude Code run in its own git checkout and pane; `pai worker ps` lists them, `follow` watches one, `merge` brings its branch back. See [workers](concepts/workers.md), [`pai worker`](commands/worker.md).

### Tiers and routing

Three tiers (session, orchestrator, workers) each hold an ordered list of models, and a routing policy decides local or cloud per run. See [delegation tiers](concepts/delegation-tiers.md), [routing policy](concepts/routing-policy.md), [escalation](concepts/escalation.md).

### Providers

`pai providers` lists them, `pai providers use NAME` switches; say "which providers". See [providers](concepts/providers.md), [`pai providers`](commands/providers.md).

### Local models

`pai models` shows every local runtime with its models, memory and users, and starts or stops one. See [local models](concepts/local-models.md), [`pai models`](commands/models.md).

### Pool and panes

A pool keeps warm spare workers; `pai pane run` runs a command in a visible pane. See [pool](concepts/pool.md), [panes](concepts/panes.md), [`pai pane`](commands/pane.md).

### Plans

`pai plan run` runs a planned job on local workers without a model in the loop; `validate`, `status` and `stop` complete it. See [plan runner](plan-runner.md), [`pai plan`](commands/plan.md).

### Queue

`pai queue add` collects small changes, `pai queue run` runs them on a local worker, `pai queue review` lets you accept or reject them in a batch. See [queue](queue.md), [`pai queue`](commands/queue.md).

### Build queue

`pai build run` serialises builds across the machine. See [builds](builds.md), [`pai build`](commands/build.md).

### Large coding jobs

The three-tier pattern for big jobs. See [three-tier coding](three-tier-coding.md).

## Router and cockpit

### Router

`pai router start`, `stop`, `restart`, `status` and `stats` run the local service that records usage per provider and schedules local runtimes. See [router](concepts/router.md), [`pai router`](commands/router.md).

### Cockpit

Open `http://127.0.0.1:8790/cockpit` for budget per provider, cache hits, models with start and stop, workers, routing and memory progress. See [cockpit](cockpit.md), [`pai cockpit`](commands/cockpit.md).

### Where tokens go

`pai audit tokens` shows where tokens are being spent; `pai skill telemetry` shows how your skills are used. See [`pai audit`](commands/audit.md), [`pai skill`](commands/skill.md).

## Messaging

### AIBroker

PAI's messaging layer is the separate project AIBroker: messages between sessions, worker reports to the session that started them, tab names, and WhatsApp, Telegram and PAILot. `pai setup` installs it. See [companion projects](companion-projects.md).

### Notifications

`pai notify status`, `set`, `test` and `send` control what reaches your phone. See [notifications](concepts/notifications.md), [`pai notify`](commands/notify.md).

## Rules, budget and advisor mode

### Whisper rules

Say "add whisper rule" or "show whisper rules". Skill `/whisper` keeps behavioural rules that are injected on every prompt. See [rules and privacy](rules-and-privacy.md).

### Budget and advisor mode

Say "budget mode" or "save budget". Skill `/advisor` chooses subagent models by how much of your weekly Claude budget is used. See [budget advisor](budget-advisor.md).

### Privacy tags

Wrap text in `<private>...</private>` to keep it out of the memory index. See [rules and privacy](rules-and-privacy.md#privacy-tags).

### Cache keepalive

Keeps a worker's provider cache warm between turns. See [cache keepalive](cache-keepalive.md).

## Images, art and sharing

### Art and diagrams

Say "create diagram", "flowchart" or "visualize". Skill `/art` makes diagrams and AI-generated images. See [skills](skills.md#tools--system).

### Share

Say "share on LinkedIn", "tweet about" or "post to Bluesky". Skill `/share` drafts posts about finished work. See [skills](skills.md#productivity).

## Research

### Research and extraction

Say "do research", "extract wisdom" or "analyze content". Skill `/research` runs web research and content analysis with parallel agents. See [skills](skills.md#tools--system).

## Setup and health

### Setup and update

`pai setup` does first-time setup (storage, search, hooks, daemon); `pai update` updates PAI. Or tell Claude "set up PAI". See [install](install/index.md), [`pai setup`](commands/setup.md), [`pai update`](commands/update.md).

### Daemon and configuration

`pai daemon status`, `start`, `stop`, `restart`, `logs`; `pai config` shows and changes settings; `pai home path` prints where PAI keeps its files. See [`pai daemon`](commands/daemon.md), [`pai config`](commands/config.md), [PAI home](pai-home.md).

### Backup and restore

`pai backup` saves the registry, config and database; `pai restore` brings them back. See [`pai backup`](commands/backup.md), [`pai restore`](commands/restore.md).

### Database and MCP tools

`pai db` looks into the PAI database read only; `pai mcp` installs the PAI tools for Claude Code. See [`pai db`](commands/db.md), [`pai mcp`](commands/mcp.md).

### Observability dashboard

Say "start observability" or "monitor agents". Skill `/observability`. See [skills](skills.md#tools--system).
