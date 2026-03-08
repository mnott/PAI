export const route = {
  description: "Detect which PAI project the current session belongs to",
  content: `## Route Skill

USE WHEN user says 'route', 'what project is this', 'tag this session', 'where does this belong', 'categorize this session', OR starting work in an unfamiliar directory needing to connect to a PAI project.

Detects current session context, searches PAI memory semantically and by keyword, and suggests which PAI project to route the session to.

### Workflow

Read CWD + project markers → search PAI memory → present top 3-5 matching projects with confidence → user picks → route and tag session.`,
};
