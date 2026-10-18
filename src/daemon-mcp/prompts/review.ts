export const review = {
  description: "Weekly/daily/monthly review of work accomplished",
  content: `## Review Skill

USE WHEN user says 'review', 'what did I do', 'this week', 'weekly review', 'daily review', 'monthly review', 'what have we achieved', 'reflect', 'retrospective', 'recap', '/review', OR asks about accomplishments over a time period.

### MANDATORY FIRST ACTIONS

When this skill triggers, first announce: "Running **PAI Review** for [period]..."

Then execute these steps IN ORDER before doing anything else. Do NOT call Calendar, Todoist, Gmail, or any external MCP until steps 1-4 are complete.

**Step 1: Find PAI session notes for the period.**

    find ~/.claude/projects/*/Notes -name "*.md" 2>/dev/null | grep "YYYY-MM-DD"

Session notes are at ~/.claude/projects/*/Notes/NNNN - YYYY-MM-DD - Description.md. Read each matching file. These describe what was actually worked on.

**Step 2: Check git commits for the period.**

    git log --after="YYYY-MM-DD" --before="YYYY-MM-DD" --oneline --all

Run this in ~/dev/ai/PAI/ and any other project directory found in session notes.

**Step 3: Check completed TODO items.**

Search for \`[x]\` items in Notes/TODO.md files of active projects.

**Step 4: Check journal entries.**

    find ~/Daten/Cloud/Development/ai/PAI/Journal/ -name "YYYY-MM-DD*" 2>/dev/null

**Step 5 (ONLY AFTER 1-4): External sources.**

Now you may check: Calendar (gcal_list_events), Todoist (find-completed-tasks), SeriousLetter (sl_list_jobs). Gmail only if specifically relevant.

### Period Selection

| Subcommand | Period |
|------------|--------|
| /review today | Today |
| /review week | Current week (Mon-Sun), DEFAULT if no period |
| /review month | Current calendar month |
| /review year | Current calendar year |

### Output Rules

**Group by THEME, not chronology.** Sections: project themes, job search, personal, key decisions, numbers (sessions/commits/tasks).

Second person voice ("You built...", "You applied to..."). Concise but warm.

Highlight completed/shipped items. Briefly note unfinished work.

**WhatsApp:** Bold headers only, no markdown headers or code blocks, under 2000 chars.
**Voice (TTS):** 30-60 sec conversational summary, top 3-5 achievements, no asterisks/markdown.`,
};
