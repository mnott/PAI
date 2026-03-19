export const reconstruct = {
  description:
    "Retroactively create session notes from JSONL transcripts and git history when automatic capture failed or was incomplete",
  content: `## Reconstruct Skill

USE WHEN user says 'reconstruct sessions', 'rebuild session notes', 'recover session notes', 'retroactively create notes', 'create notes from git history', 'notes are missing', 'backfill session notes', 'reconstruct what we did', OR /reconstruct.

### What This Skill Does

Reconstructs session notes for a PAI-registered project by reading:
1. Git commit history (authoritative record of what was built)
2. JSONL transcripts (user messages reveal intent, decisions, and context)

Generates one session note per day (or per logical session if multiple sessions existed in a day), numbered sequentially from the highest existing note number.

**ONLY include what can be verified from git log and JSONL. Never invent or embellish content.**

---

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| \`--days N\` | 7 | Reconstruct notes for the last N days |
| \`--since YYYY-MM-DD\` | — | Reconstruct from this date forward |
| \`--until YYYY-MM-DD\` | today | Reconstruct up to this date |
| \`--dry-run\` | false | Show what would be created without writing files |
| \`--commit\` | false | Git commit the created notes after writing |

---

### Pre-Action Check

Before starting, verify:

1. **Project is registered**: Run \`pai project detect\` (or \`pai project list\`) to confirm the current project is known to PAI and get its Notes directory path.
2. **Notes directory exists**: The target directory should be \`Notes/YYYY/MM/\`. Create it if absent.
3. **Find highest existing note number**: Scan all \`Notes/**/*.md\` files for the pattern \`^NNNN\` to find max note number. New notes continue from there.
4. **NEVER overwrite existing notes**: If a note file already exists for that date/session, skip it and warn the user.

---

### Step 1 — Find JSONL Files

Claude Code encodes project paths lossily: \`/\`, spaces, dots, hyphens all become \`-\`. A project may have been accessed from multiple base directories (e.g., \`~/Daten/Cloud/Development/ai/PAI\` and \`~/dev/ai/PAI\` both encode to different paths).

**Search strategy — use glob patterns, not exact paths:**

\`\`\`bash
# Find all encoded project directories that might match this project
ls ~/.claude/projects/ | grep -i "<project-slug-fragment>"

# For each candidate, look for JSONL files
ls ~/.claude/projects/<encoded-path>/*.jsonl 2>/dev/null

# Also check the dev copy if the project has one
# Example: if cwd is ~/dev/ai/PAI, also check ~/Daten/Cloud/Development/ai/PAI encoding
\`\`\`

Collect ALL JSONL files from ALL matching encoded paths. A session may have been started from either location.

---

### Step 2 — Determine Time Range

Calculate the date range from arguments:
- \`--days 7\` → from (today - 7 days) to today
- \`--since 2026-03-01\` → from that date to today (or --until date)
- Default: last 7 days

---

### Step 3 — Extract Git History

For each day in the range:

\`\`\`bash
git -C <project-dir> log \\
  --after="YYYY-MM-DD 00:00:00" \\
  --before="YYYY-MM-DD 23:59:59" \\
  --format="%H|%ad|%s" \\
  --date=short \\
  --stat
\`\`\`

Group commits by day. If no commits on a day, skip that day (no note to reconstruct).

Also capture:
- Files changed per commit (\`--stat\`)
- Author date (not committer date) for accurate day grouping

---

### Step 4 — Extract User Messages from JSONL

For each JSONL file, parse messages where \`type == "user"\` AND \`message.role == "user"\`:

\`\`\`
Each line is a JSON object. Look for:
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "..." | [{"type": "text", "text": "..."}]
  },
  "timestamp": "2026-03-15T10:23:45.000Z"
}
\`\`\`

Filter messages by timestamp to match the day being reconstructed.

Extract:
- The text content of user messages (ignore tool_result entries)
- Timestamps for ordering
- Session ID (\`sessionId\` field) to group messages per session

**SKIP** messages that are:
- Tool results (\`content\` is array with \`type: "tool_result"\`)
- System-generated (very short single-word messages like "go", "continue")
- Pure confirmations ("yes", "ok", "sounds good")

**KEEP** messages that reveal:
- Intent ("build a feature that...", "I need X to do Y")
- Decisions ("let's use approach A instead of B")
- Architectural choices
- Problem descriptions
- Requirements changes

---

### Step 5 — Identify Logical Sessions

A "logical session" is a continuous work block. Use these signals to split a day into multiple sessions:
- Gap of more than 3 hours between messages
- Different JSONL session IDs with significant time gaps
- Commits with clearly different themes separated by time

If only one logical session exists for a day, create one note. If multiple exist, create one note per session with a suffix: \`NNNN - YYYY-MM-DD - Title.md\`, \`NNNN+1 - YYYY-MM-DD - Title (2).md\`.

---

### Step 6 — Generate Note Title

The note title comes from synthesizing git commits for that session:
- If commits share a theme: use that theme ("Implement vault indexer")
- If commits are varied: use the primary/largest change ("Refactor session notes + misc fixes")
- Use the conventional commit prefix if present: "feat: Add dark mode" → "Add Dark Mode"
- Title should be 3-7 words, title-case

---

### Step 7 — Write the Note

**Note filename format:** \`NNNN - YYYY-MM-DD - Title.md\`

**Path:** \`Notes/YYYY/MM/NNNN - YYYY-MM-DD - Title.md\`

**Content template:**

\`\`\`markdown
# Session: [Title]

**Date:** YYYY-MM-DD
**Status:** Completed
**Reconstructed:** true (from JSONL + git history)

---

## Work Done

[Group related commits into logical sections by theme/component, not by commit order.
Each section describes WHAT was built and WHY, derived from commit messages and user messages.
Use present-tense descriptions: "Add X", "Fix Y", "Refactor Z".]

## Key Decisions

[Architectural choices, technology selections, approach changes.
ONLY include decisions that are explicitly stated in user messages or strongly implied by commit message changes (e.g., a series of "revert" commits followed by a new approach).
Format as bullet points.]

## Known Issues at End of Session

[Bugs discovered, things left unfinished.
Derive from: last commits in session (if they add TODOs or fix-me comments), user messages mentioning problems, or explicit "not done yet" statements.
Omit this section if nothing can be verified.]

---

**Tags:** #[project-slug] #reconstructed
\`\`\`

**Filling rules:**
- Work Done: Always present (use commits as primary source)
- Key Decisions: Only if verifiable from user messages or commit patterns
- Known Issues: Only if verifiable; omit section entirely if nothing found
- Tags: Use the PAI project slug from \`pai project detect\`

---

### Step 8 — Output Summary

After writing (or dry-run preview):

\`\`\`
Reconstructed N session notes:
  0042 - 2026-03-13 - Implement Reranker          → Notes/2026/03/
  0043 - 2026-03-14 - Add Recency Boost            → Notes/2026/03/
  0044 - 2026-03-15 - Zettelkasten Schema Update   → Notes/2026/03/

Skipped: 2026-03-12 (no commits)
Skipped: 2026-03-16 (note already exists: 0041 - 2026-03-16 - ...)
\`\`\`

If \`--commit\` was passed:
\`\`\`bash
git add Notes/
git commit -m "docs: reconstruct session notes for YYYY-MM-DD to YYYY-MM-DD"
\`\`\`

---

### Anti-Defaults

- **NEVER overwrite existing notes.** Skip silently, report in summary.
- **NEVER invent content.** If a decision isn't in the JSONL or deducible from commits, leave it out.
- **NEVER fabricate commit messages.** Copy them verbatim from git log.
- **NEVER assume intent from assistant messages.** Only user messages reveal intent.
- **NEVER add speculation.** "It appears that..." or "likely..." should not appear in notes.
- **DO trim noise.** Skip trivial messages ("ok", "yes", "go") that add no signal.
- **DO handle missing JSONL gracefully.** If no JSONL files found, generate notes from git only — mark the "Key Decisions" section as "Not available (no JSONL transcript found)".`,
};
