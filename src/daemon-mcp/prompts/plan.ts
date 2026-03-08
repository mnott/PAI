export const plan = {
  description: "Plan tomorrow, the week, or the month based on open tasks and calendar",
  content: `## Plan Skill

USE WHEN user says 'plan', 'what should I focus on', 'plan tomorrow', 'plan my week', 'what\\'s next', 'priorities', 'focus areas', '/plan', OR asks about upcoming work priorities or wants to set intentions for a time period.

### Commands

| Subcommand | Scope |
|------------|-------|
| /plan tomorrow | Next day, DEFAULT |
| /plan week | Next 7 days |
| /plan month | Next 30 days |

### Data Sources

Open TODO items \`[ ]\`, in-progress items \`[~]\`, calendar events, recent review data, journal insights tagged \`#idea\`, SeriousLetter pipeline.

### Output Format

Must Do / Should Do / Could Do (3-5 focus items max). Calendar constraints. Energy note from journal. Second-person, specific ('Add journal table to federation.db', NOT 'work on PAI').

### Rules

Never more than 7 focus items. Never plan without checking calendar first. Offer to save plan to journal.`,
};
