export const sessions = {
  description: "Navigate sessions, projects, and switch working context",
  content: `## Sessions Skill

USE WHEN user says 'list sessions', 'where was I working', 'show my sessions', 'find session', 'continue work from', 'switch to project', 'open project', 'name project', 'work on X', 'show me what we did on X', OR asks about past sessions, previous work, or project navigation.

### Key Commands

| Command | Action |
|---------|--------|
| pai session active | Show currently open Claude Code sessions |
| pai session list | Full session list |
| pai project list | Registered projects (add --all for cold ones) |
| pai "<name>" | Find a session or project by name and open it (add --dry-run to only show what would run) |
| pai open <name or id> | Open a known session by name or id |
| pai notes <project> | Session notes of a project |
| pai rename <id> <name> | Name a session |

### Intent Routing

- 'Work on X' / 'Start working on kioskpilot' → \`pai "<project>"\` (or \`pai "<project>" --dry-run\` to check the match), then read that project's TODO.md
- 'Show me sessions for PAI' / 'What did we do on X?' → \`pai notes <project>\`; for a keyword across all sessions call the PAI MCP tool \`memory_search\` (there is no CLI search command)
- 'List sessions' → run \`pai session active\` FIRST (show active tabs prominently), then \`pai session list\`
- 'List projects' → \`pai project list\`, and \`pai project list --all\` for cold ones
- 'Where are my notes going?' / 'Which project is this?' → there is no CLI command for note routing; call the PAI MCP tool \`session_route\` (it detects the project from the working directory)`,
};
