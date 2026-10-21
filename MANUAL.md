# PAI Knowledge OS — User Manual

## Introduction

PAI runs quietly in the background of every Claude Code session. It indexes your projects, session notes, and memory documents continuously — so when you ask Claude something, Claude actually knows.

You do not need to learn commands or understand the internals. Claude Code is the interface. PAI is the memory. Just ask what you need.

The more you use Claude Code, the more useful PAI becomes. Every session adds to the index automatically.

---

## Searching Your Memory

This is the most powerful thing PAI does. Every session note, project file, and memory document you have ever written is indexed and searchable — by keyword or by concept.

| What you want | What to ask Claude |
|---|---|
| Find past work on a topic | "Search your memory for authentication" |
| Find a specific session | "Find the session where we set up Docker" |
| Recall a decision | "What did we decide about the API design?" |
| Find code you wrote | "Search for that rate limiting implementation" |
| Search within one project | "Search the Whazaa project for reconnection logic" |
| Search across all projects | "Search all projects for database migration" |
| Find something conceptually | "Find anything related to performance optimization" |
| Search with better precision | "Search your memory for rate limiting using hybrid search" |

**How it works behind the scenes:**

PAI supports three search modes. Claude picks the right one automatically, or you can ask for a specific mode.

| Mode | Best for | Speed |
|---|---|---|
| Keyword | Exact terms, session numbers, identifiers | Instant |
| Semantic | Concepts, paraphrases, "find something like..." | Fast |
| Hybrid | Best overall quality, general-purpose queries | Fast |

Keyword is the default (`search.mode`) and is available right after indexing; the daemon indexes about every five minutes. Semantic and hybrid need embeddings (`pai memory embed`, or the daemon's background pass). Details: [Search](docs/search.md), [Memory](docs/memory.md). If semantic search returns nothing, ask Claude to generate embeddings first.

---

## Managing Projects

PAI keeps a registry of all your Claude Code projects. It scans your filesystem and tracks each project's path, tags, aliases, and session history.

| What you want | What to ask Claude |
|---|---|
| See all projects | "Show me all my projects" |
| Get details on a project | "Tell me about the Whazaa project" |
| Find which project you are in | "Which project am I in?" |
| Register a new project | "Add /Users/me/dev/newproject as a PAI project" |
| Archive an old project | "Archive the old-api project" |
| Tag a project | "Tag the PAI project with 'infrastructure'" |
| Find projects by tag | "Show me all projects tagged 'web'" |
| Rename or add an alias | "Add the alias 'wz' to the Whazaa project" |
| Check for broken paths | "Check if all my project paths are still valid" |
| Scan for new projects | "Scan for new projects" |

---

## Session Notes

Every Claude Code conversation is a session. PAI indexes all of them. You can search across every conversation you have ever had, find what was discussed, or link sessions across projects.

| What you want | What to ask Claude |
|---|---|
| List recent sessions | "Show my recent sessions" |
| Sessions for a project | "List sessions for the Whazaa project" |
| What happened in a session | "What did we do in session 42?" |
| Rename a session | "Rename session 42 to 'Database Migration Setup'" |
| Tag a session | "Tag session 42 with 'infrastructure'" |
| Link a session to a project | "Link this session to the PAI project" |
| Organize and clean up notes | "Clean up my session notes" |
| Find sessions from a date | "Show sessions from last week" |

The cleanup command automatically names any unnamed sessions and organizes them into date-based folders. Useful after a batch of short sessions.

---

## Obsidian Integration

PAI can sync your entire knowledge base into an Obsidian vault — a visual, linked representation of everything you have indexed. The vault uses symlinks, so edits made in Obsidian are immediately visible to PAI and vice versa. There is no separate sync step after the initial setup.

| What you want | What to ask Claude |
|---|---|
| Sync the vault | "Sync my Obsidian vault" |
| Check vault health | "How is my Obsidian vault doing?" |
| Open the vault in Obsidian | "Open my notes in Obsidian" |
| Find broken symlinks | "Check for broken symlinks in my vault" |

The vault is organized into project folders with an auto-generated index page and topic pages linking active projects and recent sessions. Any project added to the registry is automatically included the next time you sync.

---

## Reviewing, Sharing and Continuing

| What you want | What to ask Claude |
|---|---|
| Review a period | "Review my week" / "What did I do today?" (`/review`) |
| Plan ahead | "Plan my week" (`/plan`) |
| Capture a thought | "Journal this thought" (`/journal`) |
| Draft a post about shipped work | "Share on LinkedIn today", "Tweet about the vault migration", "Share on Bluesky this week" (`/share`) |
| Pick up where you stopped | "Go": the session reads the `## Continue` block in `TODO.md` |
| Recall recent activity | "What was I working on?" (recent observations are injected at session start) |
| Rebuild a missing note | `/reconstruct` creates session notes from transcripts and git history |
| Check the budget | "How much budget do I have left?", "Go easy on the budget" (`/advisor`) |

See [Skills](docs/skills.md) for every skill and trigger, [Context preservation](docs/context-preservation.md) and [Session management](docs/session-management.md) for how continuity works.

---

## Tracking Your Activity

Every significant tool call is stored as an observation of one of six kinds: decision, bugfix, feature, refactor, discovery, change.

| What you want | What to ask Claude |
|---|---|
| Recent changes | "What changes did I make to the daemon today?" |
| Past decisions | "Show me all decisions from the last session" |
| Totals | "Show observation stats" |

CLI: `pai observation list [--type KIND] [--project SLUG]`, `pai observation search "text"`, `pai observation stats`. Details: [Observations](docs/observations.md).

---

## Your Notes as a Vault (Zettelkasten)

If you keep an Obsidian vault (`vaultPath` in the config), PAI indexes its links and meaning.

| What you want | What to ask Claude |
|---|---|
| Follow a chain of links | "Explore notes linked to PAI" (`pai zettel explore`) |
| Unexpected connections | "Find surprising connections to this note" (`surprise`) |
| Emerging clusters | "What themes are emerging in my vault?" (`themes`) |
| Structural audit | "How healthy is my vault?" (`health`) |
| Link suggestions | "Suggest connections for this note" (`suggest`) |
| Ask the vault | "What does my vault say about knowledge management?" (`converse`) |

Details: [Zettelkasten](docs/zettelkasten.md).

---

## Use Cases

Typical ways people use the pieces above. [Use cases](docs/use-cases.md) has the longer list.

| Situation | What helps |
|---|---|
| Re-explaining a project every morning, or after context compaction | "Go" reading `## Continue`; [context preservation](docs/context-preservation.md) |
| "Why did we choose X?" months later | Memory search across sessions; decision observations |
| Switching between many projects or clients | The project registry; `pai ls`, `pai <name>` |
| Writing up what you shipped | `/review`, `/share` |
| Finding links between notes in a large vault | `pai zettel` operations |
| Keeping institutional knowledge when someone leaves | Each person's session notes and observations stay searchable |

---

## System Health and Maintenance

PAI is designed to run without intervention. The daemon starts on login and restarts automatically if it exits. But when something seems off, these are the things to ask.

| What you want | What to ask Claude |
|---|---|
| Check if everything is working | "How is PAI doing?" |
| See how much is indexed | "How much is indexed?" or "Show memory stats" |
| Force an immediate re-index | "Re-index everything" |
| Generate semantic embeddings | "Generate embeddings for semantic search" |
| View the daemon logs | "Show me the PAI daemon logs" |
| Restart the daemon | "Restart the PAI daemon" |
| Create a full backup | "Back up everything" |
| Restore from a backup | "Restore from the latest backup" |
| Check daemon socket | "Check the PAI daemon status" |

Backups include the project registry, configuration, and a PostgreSQL dump (`pai backup --no-postgres` skips it). They are stored in `~/.pai/backups/` with timestamps.

---

## Registry and Discovery

The registry is PAI's index of projects — their paths, slugs, aliases, tags, and session history. Claude queries it automatically when you ask project-related questions, but you can also interact with it directly.

| What you want | What to ask Claude |
|---|---|
| Scan filesystem for new projects | "Scan for new projects" |
| Look up a project by path | "What project is /Users/me/dev/myapp in?" |
| See registry statistics | "Show me registry stats" |
| Register a project manually | "Register /Users/me/dev/myapp as a PAI project" |
| Remove a stale project | "Archive the project at /Users/me/dev/old-app" |

---

## Advanced: CLI Reference

For users who prefer the terminal, every action above has a CLI equivalent. PAI's CLI is called `pai`.

Start with the daily commands:

```bash
pai                 # picker: newest sessions first, type to filter, Enter opens
pai NAME            # open a session by name
pai ls              # sessions as a plain table
pai setups          # orchestrator + worker combinations
pai more            # every other command, grouped
pai help <command>  # full help for one command
```

The commands below all still work; `pai more` lists them by group.

```bash
# Projects
pai project list                                     # List all projects
pai project info my-app                              # Project details
pai project health                                   # Check that project folders exist
pai project tag my-app infrastructure                # Tag a project
pai project archive old-api                          # Archive a project

# Sessions
pai session list --project my-app                    # Sessions for a project
pai rename ID "Database Migration"                   # Rename a session
pai session cleanup                                  # Drop empty notes, name, file and renumber

# Memory and search
pai memory search "rate limiting"                    # Keyword search
pai memory search --mode semantic "reconnect logic"  # Semantic search
pai memory search --mode hybrid "auth flow"          # Hybrid search
pai memory status                                    # Index statistics
pai memory embed                                     # Generate embeddings

# Daemon
pai daemon status                                    # Check daemon health
pai daemon logs                                      # View daemon logs
pai daemon restart                                   # Restart the daemon
pai daemon install                                   # Install as launchd service

# Obsidian
pai obsidian sync                                    # Sync vault
pai obsidian status                                  # Vault health report
pai obsidian open                                    # Open in Obsidian

# Registry
pai registry scan                                    # Discover new projects
pai registry stats                                   # Registry statistics

# Backup and restore
pai backup                                           # Create a backup
pai restore ~/.pai/backups/2026-02-25T14-30-00       # Restore from backup

# Setup
pai setup                                            # Re-run the setup wizard

# Worker providers (subagents on your own endpoints)
pai worker run -p '<task spec>' --output-format json # Run one worker
pai worker ps                                        # This session's workers
pai worker providers add <name> --base-url <url> …   # Configure a provider
pai worker on                                        # Send Agent-tool subagents to workers
```

For the full CLI reference including all subcommands and flags, see [the command pages](docs/commands/README.md) or `pai more`.

---

## Worker Providers

PAI can run subagents (research, implementation, spotchecks) on an endpoint you
configure instead of the main session's Anthropic account. Ask Claude to
delegate through workers, or use the CLI above. `pai worker ps` lists running
workers, the status line shows their current step, and `pai worker follow`
tails one live. Work is delegated over three tiers (session, orchestrator, workers; local model first): see [delegation tiers](docs/concepts/delegation-tiers.md), [workers](docs/concepts/workers.md) and the [cockpit](docs/cockpit.md). First setup: [docs/install/first-workers.md](docs/install/first-workers.md). Full reference: [docs/worker.md](docs/worker.md).

---

## Troubleshooting

| Problem | What to do |
|---|---|
| "PAI doesn't know about my recent work" | The daemon indexes every five minutes. Ask Claude to "re-index everything" for immediate results. |
| "Semantic search returns nothing" | Embeddings may not be generated yet. Ask Claude to "generate embeddings" and try again in a few minutes. |
| "Claude doesn't have PAI tools available" | Run `pai mcp install` to register the MCP server (`pai mcp status` checks it), then restart Claude Code. |
| "The daemon is not running" | Ask Claude to "restart the PAI daemon" or run `pai daemon install` to re-register it with launchd. |
| "Search returns irrelevant results" | Try hybrid mode: "Search your memory for X using hybrid search". |
| "A project is missing from the list" | Ask Claude to "scan for new projects" to pick up any projects PAI hasn't seen yet. |
| "Obsidian vault has broken links" | Ask Claude to "check my Obsidian vault health". Broken symlinks mean a project path has moved — update it with `pai project move`. |
| "I want to start fresh" | Ask Claude to "re-run the PAI setup wizard" or run `pai setup` in the terminal. |
