# Automatic Observation Capture

PAI automatically classifies and stores every significant tool call during your sessions. When you edit a file, run a command, or make a decision, PAI captures it as a structured observation — building a searchable timeline of everything you've done across all projects.

## How it works

A PostToolUse hook fires after every Claude Code tool call. A rule-based classifier (no AI needed, under 50ms) categorizes each action:

| Type | What triggers it | Examples |
|------|-----------------|----------|
| **decision** | Git commits, config changes | `git commit`, writing to config files |
| **bugfix** | Test runs, error investigation | `npm test`, debugging commands |
| **feature** | New file creation, feature work | Creating components, adding endpoints |
| **refactor** | Code restructuring | Renaming, moving files, reorganizing |
| **discovery** | File reads, searches | Reading code, grep searches, glob patterns |
| **change** | File edits | Editing source files, updating configs |

Observations are stored with content-hash deduplication (30-second window) to prevent duplicates from rapid tool calls.

## Progressive context injection

At session start, PAI injects recent observations as layered context:

1. **Compact index** (~100 tokens) — observation type counts and active projects
2. **Timeline** (~500 tokens) — recent observations with timestamps
3. **On-demand** — full details available via MCP tools

This means Claude starts every session already knowing what you were working on, without you re-explaining anything.

## Searching observations

Ask Claude naturally:

```
"What changes did I make to the daemon today?"
"Show me all decisions from the last session"
"What files did I modify in the PAI project this week?"
```

Or use the CLI:

```bash
# List recent observations
pai observation list

# Filter by type
pai observation list --type decision

# Filter by project
pai observation list --project pai

# Show stats
pai observation stats
```

## Session summaries

When a session ends, PAI generates a structured summary capturing what was requested, investigated, learned, completed, and what the next steps are. These summaries feed into the progressive context system, giving future sessions a concise picture of past work.
