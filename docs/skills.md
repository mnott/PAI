# Skills

PAI ships 22 skills — slash commands that activate specialized workflows. Each responds to natural language triggers as well as the `/command` syntax.

## Productivity

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/advisor` | "budget mode", "save budget", "go easy on the budget" | Manage budget-aware model tiering for subagents |
| `/plan` | "plan my week", "what should I focus on", "priorities" | Plan tomorrow/week/month based on open tasks and calendar |
| `/review` | "review my week", "what did I do", "recap" | Daily/weekly/monthly review of work accomplished |
| `/journal` | "journal", "note to self", "capture this thought" | Create, read, or search personal journal entries |
| `/share` | "share on LinkedIn", "tweet about", "post to Bluesky" | Generate social media posts about completed work |

## Session Management

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/sessions` | "list sessions", "where was I working" | Navigate sessions, projects, switch working context |
| `/route` | "what project is this", "tag this session" | Detect which PAI project the current session belongs to |
| `/name` | "name this session", "rename session" | Name or rename the current session |
| `/search-history` | "search history", "find past", "what did we do" | Search past sessions and previous work by keyword |
| `/consolidate` | "consolidate notes", "clean up notes", "merge duplicates" | Merge duplicate session notes, fix titles, renumber |
| `/reconstruct` | "reconstruct sessions", "backfill session notes" | Retroactively create notes from JSONL transcripts and git history |

## Obsidian Vault

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/vault-context` | "morning briefing", "load vault context" | Load Obsidian vault context for a briefing |
| `/vault-connect` | "connect X and Y", "how does X relate to Y" | Find connections between two topics in the vault |
| `/vault-emerge` | "what's emerging", "find patterns", "themes in vault" | Surface emerging themes and clusters |
| `/vault-orphans` | "find orphans", "unlinked notes" | Find and reconnect orphaned notes with zero inbound links |
| `/vault-trace` | "trace idea", "how did X evolve", "idea history" | Trace the evolution of an idea across vault notes over time |

## Tools & System

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/whisper` | "add whisper rule", "show whisper rules" | Manage persistent behavioral constraints injected on every prompt |
| `/research` | "do research", "extract wisdom", "analyze content" | Web research, content extraction, and analysis via parallel agents |
| `/art` | "create diagram", "flowchart", "visualize" | Create visual content, diagrams, flowcharts, and AI-generated images |
| `/story` | "explain this as a story", "create story explanation" | Create numbered narrative story explanations of any content |
| `/observability` | "start observability", "monitor agents" | Start, stop, or check the multi-agent observability dashboard |
| `/createskill` | "create skill", "validate skill" | Create, validate, update, or canonicalize a PAI skill |
