# What You Can Ask Claude

## Searching Your Memory

- "Search your memory for authentication" — finds past sessions about auth, even with different words
- "What do you know about the Whazaa project?" — retrieves full project context instantly
- "Find where we discussed the database migration" — semantic search finds it even if you phrase it differently
- "Search your memory for that Chrome browser issue" — keyword and meaning-based search combined

## Managing Projects

- "Show me all my projects" — lists everything PAI tracks with stats
- "Which project am I in?" — auto-detects from your current directory
- "What's the status of the PAI project?" — full project details, sessions, last activity
- "How many sessions does Whazaa have?" — project-level session history

## Navigating Sessions

- "List my recent sessions" — shows what you've been working on across all projects
- "What did we do in session 42?" — retrieves any specific session by number
- "What were we working on last week?" — Claude knows, without you re-explaining
- "Clean up my session notes" — auto-names unnamed sessions and organizes by date

## Reviewing Your Work

- "Review my week" — synthesizes session notes, git commits, and completed tasks into a themed narrative
- "What did I do today?" — daily review across all projects
- "Journal this thought" — capture freeform reflections with timestamps
- "Plan my week" — forward-looking priorities based on open TODOs and recent activity
- "What themes are emerging in my work?" — spot patterns across sessions and projects

## Sharing Your Work

- "Share on LinkedIn today" — generates a professional post about what you shipped, with real numbers and technical substance
- "Tweet about the vault migration" — punchy X/Twitter post or thread, with option to post directly
- "Share on Bluesky this week" — conversational technical post for the Bluesky audience
- Platform-aware formatting: LinkedIn gets hashtags and narrative, X gets threads and hooks, Bluesky gets conversational tone

## Tracking Your Activity

- "What changes did I make to the daemon today?" — automatic observation capture tracks every tool call
- "Show me all decisions from the last session" — observations are classified: decision, bugfix, feature, refactor, discovery, change
- "What files did I modify in the PAI project this week?" — searchable timeline of every edit, commit, and search
- "Show observation stats" — totals, breakdowns by type and project, with visual bar charts

## Continuing Where You Left Off

- "Go" — reads your TODO.md continuation prompt and picks up exactly where the last session stopped
- "What was I working on?" — progressive context injection loads recent observations at session start
- "Continue the daemon refactor" — session summaries give Claude full context without re-explaining
- "/reconstruct" — retroactively creates session notes from JSONL transcripts and git history when automatic capture missed a session

## Keeping Things Safe

- "Back up everything" — creates a timestamped backup of all your data
- "How's the system doing?" — checks daemon health, index stats, embedding coverage

## Obsidian Integration

- "Sync my Obsidian vault" — updates your linked vault with the latest notes
- "Open my notes in Obsidian" — launches Obsidian with your full knowledge graph

## Zettelkasten Intelligence

- "Explore notes linked to PAI" — follow trains of thought through wikilink chains
- "Find surprising connections to this note" — discover semantically similar but graph-distant notes
- "What themes are emerging in my vault?" — detect clusters of related notes forming new ideas
- "How healthy is my vault?" — structural audit: dead links, orphans, disconnected clusters
- "Suggest connections for this note" — proactive link suggestions using semantic + graph signals
- "What does my vault say about knowledge management?" — use the vault as a thinking partner

## Budget Management

- "How much budget do I have left?" — shows current weekly usage and advisor mode
- "Go easy on the budget" — switches to conservative mode (prefer haiku subagents)
- "Lock it down" — switches to critical mode (minimize all token usage)
- "Go full power" — switches to normal mode (no constraints)
- "Back to auto" — resets to auto mode (derives from weekly budget percentage)
