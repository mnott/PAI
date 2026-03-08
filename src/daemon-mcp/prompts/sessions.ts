export const sessions = {
  description: "Navigate sessions, projects, and switch working context",
  content: `## Sessions Skill

USE WHEN user says 'list sessions', 'where was I working', 'show my sessions', 'find session', 'continue work from', 'switch to project', 'open project', 'name project', 'work on X', 'show me what we did on X', OR asks about past sessions, previous work, or project navigation.

### Key Commands

| Command | Action |
|---------|--------|
| pai session active | Show currently open Claude Code sessions |
| pai session list | Full session list |
| pai search "keyword" | Find sessions by keyword |
| pai route <project> | Route notes to a project |
| pai route | Show current routing |
| pai route clear | Stop routing |
| pai open <project> --claude | Open project in new tab |
| pai name "Name" | Name current project |

### Intent Routing

- 'Work on X' / 'Start working on kioskpilot' → \`pai route <project>\`, then read that project's TODO.md
- 'Show me sessions for PAI' / 'What did we do on X?' → \`pai search <project>\`
- 'List sessions' → run \`pai session active\` FIRST (show active tabs prominently), then \`pai session list\`
- 'Where are my notes going?' → \`pai route\` (no args)`,
};
