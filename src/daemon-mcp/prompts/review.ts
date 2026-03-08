export const review = {
  description: "Weekly/daily/monthly review of work accomplished",
  content: `## Review Skill

USE WHEN user says 'review', 'what did I do', 'this week', 'weekly review', 'daily review', 'monthly review', 'what have we achieved', 'reflect', 'retrospective', 'recap', '/review', OR asks about accomplishments over a time period.

### Commands

| Subcommand | Period |
|------------|--------|
| /review today | Today |
| /review week | Current week (Mon-Sun), DEFAULT if no period |
| /review month | Current calendar month |
| /review year | Current calendar year |

### Data Sources

Session notes (\`~/.claude/projects/*/Notes/\`), git commits, completed TODO items \`[x]\`, journal entries (\`\${PAI_DIR}/Journal/\`), SeriousLetter jobs (if available), Todoist completed tasks (if available), calendar events (if available).

### Output Format

Group by THEME not chronology. Sections: project themes, job search, personal, key decisions, numbers (sessions/commits/tasks). Second-person voice ('You built...', 'You applied to...'). Highlight completed and shipped items.

**WhatsApp:** Condensed, bold headers, under 2000 chars. Voice: 30-60 sec conversational summary, top 3-5 achievements.`,
};
